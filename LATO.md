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
