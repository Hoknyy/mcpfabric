# Harnais de test MCPFabric — protocole 2

Le runner pilote le client authentifié par le launcher. Un run contrôle une seule session
Minecraft. Les actions restent soumises aux permissions du joueur sur le serveur.

## Préparation

1. Construire le MCP : `cd mcp-server`, `npm ci`, `npm run build`.
2. Installer le JAR Lato `0.2.2-lato.2+26.2` dans le profil Fabric 26.2, puis redémarrer Minecraft.
3. Depuis `harness`, `npm ci`, puis `node runner.mjs --doctor` une fois connecté au staging.

Le doctor compare l'identité réellement renvoyée par le mod et l'adresse du serveur avec
`config.json`. Un HTTP 204 de Pterodactyl signifie « requête acceptée », pas « fixture vérifiée ».

```powershell
node runner.mjs scenarios/smoke.yaml
node runner.mjs scenarios/menu.yaml
npm test
```

`menu.yaml` ouvre le menu et le shop sans achat. Les scénarios `shop-buy-wheat.yaml` et
`v0-journey.yaml` sont destructifs : leur exécution exige que l'UUID réel soit dans
`config.disposablePlayerUuids`. Cette liste est volontairement vide. Ne pas y inscrire un
compte personnel à conserver : ces scénarios normalisent son inventaire et son solde,
et ne restaurent pas un état personnel antérieur. Aucun contournement CLI n'est fourni.

Le parcours claim/home exige des claim blocks déjà disponibles sur le compte jetable.
Il ne distribue plus 1 000 blocs à chaque run. Il utilise un home `mcp_<runId>`, vérifie
les messages système nouveaux et le retour à la position enregistrée, puis abandonne
le claim créé et supprime ce home. Le cooldown RTP réel reste de 600 s : ce parcours
n'est pas le smoke test à lancer après chaque édition. Une erreur de nettoyage rend
le run FAIL ; consulter le rapport avant de relancer. Si une création a eu lieu mais que
sa confirmation est perdue, le runner ne supprime pas un claim supposé : inspecter le
compte jetable et réconcilier cet état avant le prochain run. Les assertions de chat GriefPrevention
3D et HuskHomes sont alignées sur les messages du staging lus le 18 septembre 2026 ; elles ne
constituent pas un test de protection contre un deuxième joueur.

## Contrat des scénarios

```yaml
name: menu
steps:
  - call: chat.send
    args: { message: "/menu" }
  - call: container.read
    retry: { timeout: 5, interval: 0.2 }
    expect:
      title: "Asteria Online - Menu"
      itemAt: { 10: { name: Shop } }
  - call: container.click
    args: { slot: 10, expectedItemName: Shop }
  - call: container.read
    retry: 5
    expect: { title: "Server Shop" }
teardown:
  - call: gui.close
    optional: true
```

- `call` / `args` : appel du bridge. Le MCP et le runner acquièrent automatiquement un
  contrôle exclusif renouvelable. Un deuxième agent reçoit `control_busy`.
- `retry` : réservé aux lectures. Une action est envoyée une seule fois. Après timeout
  de transport ou `action_uncertain`, inspecter le résultat avant toute nouvelle action.
- `expect_chat` : seulement les messages système apparus après la dernière action du
  runner. Le curseur est capturé avant l'action ; un redémarrage/perte d'historique fait
  échouer la preuve. Pour du chat de joueurs, utiliser explicitement une lecture d'événements.
- `save` : sauvegarde le résultat. `{{nom.champ}}` accède à un champ ; une expression qui
  occupe toute la valeur conserve le type (objet/nombre). Une variable inconnue fait échouer.
- `console: {server, command}` : fixture exécutée par le transport canonique AA-Main,
  sur compte jetable uniquement. Ajouter ensuite une assertion de l'état réellement obtenu.
- `teardown` : exécuté même après échec. `when: nomSauvegarde` conditionne un nettoyage
  à une étape effectivement réussie. Une étape de cleanup qui échoue bloque ses étapes
  suivantes pour éviter d'agir à partir d'une précondition fausse.
- `optional: true` : uniquement pour `gui.close` lorsqu'aucun écran n'est ouvert.
- `wait` : pause bornée ; préférer une lecture avec assertion et retry.
- `connection.disconnect` puis `connection.join` : reconnexion sans humain. Le join
  n'exige pas de monde chargé mais seulement l'adresse de la configuration, qui doit
  aussi figurer dans `allowedJoinAddresses` du mod ; relire ensuite `player.getState`
  avec `retry` pour réassocier l'identité.
- `continueOnError` : poursuit les étapes, mais conserve le statut FAIL.

Assertions : égalité sur chemin (`title`, `items.0.name`), `itemAt`, `loreContains`,
`contains`, `gte`, `lte`, `inventoryCount`, `inventoryDelta`, `nearPosition` et
`snbtEquals` (égalité NBT d'un texte SNBT, ordre d'affichage des clés ignoré).
Exemple : `nearPosition: {baseline: "{{destination}}", tolerance: 2}` compare les trois
coordonnées ET la dimension. `inventoryDelta: {baseline: "{{avant}}", id: "minecraft:wheat",
delta: 1}` vérifie la livraison. L'ancien `expect.chatContains` est refusé.
Un scénario vide ou dépourvu d'assertion n'est pas un test valide.

Avant `container.click`, lire/assertir le conteneur : le runner réutilise le `menuId`,
le `stateId` et le titre observés. Une mutation invalide ce cache. Les utilisateurs des
outils MCP fournissent explicitement ces préconditions depuis `container_read`/`gui_list`.

## Rapports et configuration

Chaque run produit `artifacts/<scenario>/<runId>/report.json` avec cible, version du bridge,
résultats observés, tentatives, durées, échecs et cleanup. Screenshots d'échec et captures
demandées restent dans le même dossier. Les données de chat/inventaire sont des données
de test locales ; ces artefacts sont ignorés par Git.

Options : `--config`, `--url`, `--token`, `--var player=Nom`, `--artifacts`.
Préférer le token lu à l'exécution depuis le profil ou `MCPFABRIC_TOKEN` à un argument CLI.
`config.python` doit être l'exécutable Python (runtime partagé), pas un `.cmd` : les
commandes console sont transmises en JSON sur stdin, sans interpolation shell.
`config.sources` référence le registre d'AA-Lato, qui référence à son tour les ressources
AA-Main. Aucune clé API n'est copiée dans le fork.

Le shop et `/eco` utilisent EternalEconomy via Vault ; `/money` est une autre économie.
Vérifier les soldes du shop via sa lore. Les succès UI n'impliquent jamais une réussite
serveur : c'est l'assertion suivante qui l'établit.
