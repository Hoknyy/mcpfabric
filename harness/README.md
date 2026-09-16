# Harnais de test MCPFabric

Runner de scénarios pour piloter le client Minecraft via le bridge du mod et
vérifier le résultat (assertions), sans toucher au clavier/souris.

## Usage

```bash
npm install
node runner.mjs scenarios/smoke.yaml --token <token du bridge>
```

Le token est dans `config/mcpfabric.config.json` du profil Minecraft.
Variables d'environnement acceptées : `MCPFABRIC_URL`, `MCPFABRIC_TOKEN`.
En cas d'échec, un screenshot est écrit dans `artifacts/<scenario>/`.

## Format d'un scénario

```yaml
name: shop-buy-wheat
steps:
  - call: chat.send                 # méthode du bridge
    args: { message: "/menu" }      # paramètres
  - call: container.read
    retry: 5                        # rejoue l'appel jusqu'à 5 s si les assertions échouent
    expect:                         # assertions sur le résultat
      title: "Asteria Online - Menu"
      itemAt:
        10: { name: Shop }
  - call: container.click
    args: { slot: 10 }
    optional: true                  # un échec n'arrête pas le scénario
  - expect_chat: "You bought"       # attend un message de chat (polling)
    timeout: 6
  - call: vision.screenshot
    screenshot: true                # enregistre aussi le screenshot en cas de succès
```

Assertions disponibles dans `expect` :

- `cle: valeur` — égalité stricte sur un chemin (`title`, `items.0.name`…) ;
- `itemAt: { <slot>: { name: ..., id: ... } }` — pour `container.read` ;
- `contains: { chemin: "sous-chaîne" }` ;
- `gte` / `lte: { chemin: nombre }`.

## Scénarios fournis

- `smoke.yaml` — le bridge répond, le joueur est dans un monde, description de scène.
- `shop-buy-wheat.yaml` — funnel d'achat EconomyShopGUI complet (Menu → Shop →
  Farming → Wheat → achat). Nécessite un compte crédité.
