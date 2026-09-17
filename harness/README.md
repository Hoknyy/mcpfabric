# Harnais de test MCPFabric

Runner de scénarios pour piloter le client Minecraft via le bridge du mod, préparer l'état
du serveur (fixtures par console Pterodactyl) et vérifier le résultat par des assertions —
sans toucher au clavier/souris.

## Prérequis

- Minecraft ouvert sur le profil Modrinth `Fabric 26.2` (mod `mcpfabric` chargé, bridge sur
  `127.0.0.1:25599`). C'est la seule action manuelle restante : si le bridge ne répond pas,
  demander à l'utilisateur d'ouvrir le jeu.
- Le token est résolu automatiquement depuis `config/mcpfabric.config.json` du profil
  (chemin dans `config.json`), ou via `--token` / `MCPFABRIC_TOKEN`.
- Console Pterodactyl : `config.json` pointe le runtime Python d'AA-Main ; `panel_cmd.py`
  consomme `panel_transport.py` d'AA-Main (clé API lue à l'exécution dans le secret AA-Main).

## Vérifier l'environnement

```bash
node runner.mjs --doctor
```

Contrôle : bridge joignable, joueur dans un monde, token résolu, console Pterodactyl.

## Lancer un scénario

```bash
node runner.mjs scenarios/shop-buy-wheat.yaml
```

Options : `--url`, `--token`, `--var player=Nom`, `--artifacts <dir>`.
En cas d'échec, un screenshot est écrit dans `artifacts/<scenario>/`.

## Format d'un scénario

```yaml
name: shop-buy-wheat
vars:
  player: Tikifirst
steps:
  - console: { server: survival, command: "eco set {{player}} 100" }   # fixture
  - wait: 1
  - call: chat.send
    args: { message: "/menu" }
  - call: container.read
    retry: 5
    expect:
      title: "Asteria Online - Menu"
      itemAt: { 10: { name: Shop } }
      loreContains: { 45: "Balance: $100.00" }
  - call: container.click
    args: { slot: 10 }
    optional: true
  - expect_chat: "successfully bought"
    timeout: 6
```

Étapes disponibles :

- `call` + `args` — appel bridge (`gui.*`, `container.*`, `chat.*`, `player.*`, `vision.*`…) ;
- `console` — commande console Pterodactyl (`server`: `survival` | `lobby` | `proxy`) ;
- `wait` — pause en secondes ;
- `expect_chat` — attend un message de chat (polling) ;
- `log` — simple commentaire.

Assertions dans `expect` :

- `cle: valeur` — égalité stricte sur un chemin (`title`, `items.0.name`…) ;
- `itemAt: { <slot>: { name|id|count: ... } }` — pour `container.read` ;
- `loreContains: { <slot>: "sous-chaîne" }` — prix/soldes affichés en lore ;
- `contains: { chemin: "sous-chaîne" }` ; `gte` / `lte: { chemin: nombre }`.

Modificateurs d'étape : `retry` (secondes ou `{timeout, interval}`), `optional`, `save`,
`screenshot`, et `continueOnError` au niveau scénario. Les `{{vars}}` sont substitués
partout (args, commandes console).

## Serveurs (fixtures)

`config.json` mappe les serveurs du réseau staging AA-Lato :

| nom | rôle |
| --- | --- |
| `survival` | backend Paper (plugins, économie, shop) |
| `lobby` | lobby |
| `proxy` | Velocity |

## Pièges connus

- **Deux économies** : le shop (EconomyShopGUI) et `/eco` utilisent **EternalEconomy**
  (Vault) ; `/money` répond via un autre plugin et peut afficher un autre solde. Assertir
  le solde via la **lore de la tête joueur** du shop, pas via `/money`.
- Le prix d'un item est dans sa **lore** (`container.read` la renvoie).
- Les timestamps de `logs/latest.log` ne sont pas fiables pour corréler (préférer le chat
  in-game via `chat.getRecent`).
