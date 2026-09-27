# Fork LATO de MCPFabric

Ce fork sert de base au harnais de test des serveurs AA-Lato : un client
Minecraft piloté par agents (MCP) pour observer, jouer et vérifier les boucles
de gameplay sur le staging, avec à terme des scénarios automatisés.

- `origin` : `Hoknyy/mcpfabric` (ce fork)
- `upstream` : `Etoryx/mcpfabric` (source amont, MIT)
- Branche de travail : `lato/dev` ; `main` reste alignée sur l'amont.

## Règle de fork

- Garder les changements génériques (outils MCP, robustesse) pour pouvoir les
  proposer en PR upstream.
- Ne pas renommer le mod (`mcpfabric`) ni les packages `dev.mcpfabric.*` :
  le renommage casserait la synchro amont. Les ajouts purement LATO (scénarios,
  plugin serveur `LatoTest`) vivent dans des fichiers/dossiers à part.

## Roadmap des extensions

Fait (branche `lato/dev`) :

- `gui.list` : arbre des widgets (type, texte, position, taille, état, valeur des
  champs texte) ;
- `gui.click` : clic par index, par texte ou par coordonnées ;
- `gui.type` : saisie de texte (+ `clear`, `enter`) ;
- `gui.key` : touche nommée ou code GLFW ;
- `gui.close` ;
- `container.read` / `container.click` : lecture des slots non vides et clic
  slot (pickup, quick_move, throw, swap, bouton gauche/droit).
- `connection.status` / `connection.disconnect` / `connection.join` : quitter le
  serveur comme le bouton du menu pause et rejoindre une adresse listée dans
  `allowedJoinAddresses` (vide par défaut : connexion refusée), en 26.2 ;
- `players.tabList` (lecture seule) : entrées de la liste des joueurs du client
  (UUID, nom, nom affiché, mode de jeu, latence, listé ou non), en-tête et pied du
  tab en texte brut (accesseur mixin client) ; assertions `includes` / `excludes`
  du harnais ;
- Compatibilité : API d'événements GUI par records à partir de 1.21.9
  (`MouseButtonEvent`, `CharacterEvent`, `KeyEvent`) ; accès à l'écran courant
  via `mc.gui.screen()` à partir de 26.2.

Reste à faire :

- `hud.read` : sidebar, bossbar, actionbar, titres ;
- `chat.subscribe` : flux chat au lieu du polling ;
- `events` étendus : ouverture/fermeture d'écran, pickup, level up, mort ;
- `container.move` : déplacement slot→slot en une commande.

Côté serveur (plugin Paper `LatoTest`, à créer) :

- `cmd.run` avec sortie capturée (le `run_command` actuel exige un serveur
  intégré) ;
- `economy.get/set`, `shop.list` (prix via Vault / QuickShop / EconomyShopGUI) ;
- `player.reset/give`, `world.snapshot/restore` pour des fixtures répétables.

Côté harnais (hors Minecraft) — fait dans `harness/` :

- scénarios YAML exécutés via le bridge, avec assertions, retry, screenshots d'échec
  et rapport (pass/fail, durées) ;
- fixtures serveur par console Pterodactyl (`panel_cmd.py` consomme le transport
  d'AA-Main), étape `console` dans les scénarios ;
- `node runner.mjs --doctor` pour valider l'environnement avant de tester.

Reste à faire côté harnais :

- exécution sur le staging à chaque changement des plugins `Lato*` (déclenchement) ;
- assertions de solde par API plutôt que par lore quand un plugin LATO le permettra.

## Build

```bash
# Mod (par version MC, JDK 25 pour la ligne 26.x)
gradlew.bat ":26.2:build"        # jar dans versions/26.2/build/libs/

# Serveur MCP (Node >= 20)
cd mcp-server && npm ci && npm run build
```

Config client MCP (opencode) :

```jsonc
"mcpfabric": {
  "type": "local",
  "command": ["node", "<chemin>/mcp-server/dist/index.js"],
  "environment": {
    "MCPFABRIC_URL": "http://127.0.0.1:25599",
    "MCPFABRIC_TOKEN": "<token de config/mcpfabric.config.json>"
  }
}
```

## Correctifs de fiabilité — 2026-09-18

Version du mod/MCP : `0.2.2-lato.1`, protocole bridge **2**. Le mod et le serveur MCP
se mettent à jour ensemble ; redémarrage du client nécessaire après remplacement du JAR.

- Toutes les écritures RPC requièrent une prise de contrôle exclusive (`control.acquire`,
  `_session` sur les écritures, `control.heartbeat`, `control.release`). Le MCP et le
  runner la gèrent ; un client HTTP direct doit la gérer explicitement. Durée par défaut
  10 s, configurable entre 1 et 30 s via `controlLeaseMs`.
- `control.stopAll`, `control.stop` et `nav.stop` arrêtent les inputs, navigation, minage
  et utilisation d'objet et révoquent la session. Les arrêts restent disponibles même
  si le contrôle est désactivé. Expiration, changement de joueur/monde et mort relâchent
  les inputs du bot, sans écraser chaque tick les touches physiques de l'utilisateur.
- Les guards sont vérifiés à la réception ET sur le thread du jeu. Une tâche expirée
  encore en file n'est pas exécutée. Une tâche déjà commencée peut répondre
  `action_uncertain` : vérifier l'état, jamais répéter aveuglément.
- `container.click` exige `expectedMenuId`; `expectedStateId`, titre et item peuvent
  renforcer la précondition. `gui.*` en écriture exige `expectedScreen` et le menuId
  lorsqu'un conteneur est ouvert. Les valeurs proviennent des outils de lecture.
- `player.getState` expose nom, UUID et adresse distante ; `container.read` expose état
  du menu et objet au curseur. Les événements incluent `streamId`, `oldestId`, `lastId`.
- `enablePlayerControl` est appliqué aux écritures client, `enableVision` aux deux outils
  de vision et `enableWorldWrite` aux écritures serveur. `enableCommands` concerne le
  RPC administratif `command.run` ; il ne constitue pas un filtrage des commandes que
  le joueur peut émettre depuis une GUI/chat, qui relèvent du contrôle client.
- MCP `stdio` reste le défaut. Le mode HTTP local exige désormais un token d'appelant
  distinct configuré avec `MCPFABRIC_HTTP_TOKEN` et contrôle Host/Origin sur chaque
  requête. Seuls localhost/127.0.0.1 au port configuré sont acceptés ; les clients natifs
  sans Origin restent supportés. Corps et sessions sont bornés.

Tests : `npm test` dans `mcp-server`, puis `npm test` dans `harness` ;
`gradlew.bat :26.2:build` exécute aussi `safetyTest` (assertions Java, sans dépendance JUnit).
Le workflow Build couvre maintenant les pushes `lato/dev` et les régressions du harnais.
HUD structuré, optimisation des screenshots et navigation avancée restent des extensions
ultérieures ; elles ne sont pas nécessaires pour corriger les erreurs de validation.
