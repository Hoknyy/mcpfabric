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

Côté mod client (manques identifiés le 2026-09-17) :

- `gui.list` : arbre des widgets (type, texte, position, état) ;
- `gui.click` / `gui.type` / `gui.key` / `gui.close` : interaction GUI robuste
  (remplace le pilotage souris/clavier Windows, fragile) ;
- `container.read` / `container.move` : lecture et déplacement d'items
  slot→slot (coffres, shops QuickShop, inventaires) ;
- `hud.read` : sidebar, bossbar, actionbar, titres ;
- `chat.subscribe` : flux chat au lieu du polling ;
- `events` étendus : ouverture/fermeture d'écran, pickup, level up, mort.

Côté serveur (plugin Paper `LatoTest`, à créer) :

- `cmd.run` avec sortie capturée (le `run_command` actuel exige un serveur
  intégré) ;
- `economy.get/set`, `shop.list` (prix via Vault / QuickShop / EconomyShopGUI) ;
- `player.reset/give`, `world.snapshot/restore` pour des fixtures répétables.

Côté harnais (hors Minecraft) :

- scénarios YAML/JSON exécutés via MCP, avec assertions et rapport
  (pass/fail, durées, screenshots par étape) ;
- exécution sur le staging à chaque changement des plugins `Lato*`.

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
