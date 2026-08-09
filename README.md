# sowel-recipe-water-heater-smart

Recette Sowel pour piloter un **chauffe-eau électrique** derrière un simple relais marche/arrêt (Zigbee, Tasmota, …), sans consigne de température : c'est le thermostat mécanique du ballon qui décide de la température finale, la recette décide seulement **quand** la résistance a le droit de consommer.

## Ce que ça fait

Trois raisons de chauffer, par priorité décroissante :

| Priorité | Motif | Déclencheur | Arrêt |
| --- | --- | --- | --- |
| 1 | **Plancher d'eau chaude** | Sonde bas de ballon sous `minTemp` | `rescueTemp` atteinte, ou coupure du thermostat |
| 2 | **Heures creuses** | Fenêtre HC, cycle calé en fin de plage | Coupure du thermostat, ou fin de plage |
| 3 | **Surplus solaire** | Export ≥ puissance + marge, confirmé | Export perdu, confirmé, ou coupure du thermostat |

Le plancher passe avant tout : au gîte, une série de douches en pleine journée vide le ballon hors heures creuses et sans soleil — la recette rechauffe quand même, le prix du kWh ne vaut pas de l'eau froide.

## Détection « ballon plein »

Le ballon n'expose pas de consigne haute exploitable : son thermostat s'ouvre tout seul quand l'eau est chaude. Ça se voit sur la **puissance mesurée**, qui s'effondre de ~2,2 kW à ~0 W alors que le relais est toujours fermé. Maintenu pendant `cutoffDelay`, ça vaut « ballon plein » → le relais s'ouvre et le cycle sert à affiner l'estimation de durée.

La sonde du bas ne peut pas jouer ce rôle : par stratification, elle lit froid pendant que le haut du ballon est à 60 °C. C'est exactement pour ça que la puissance est le capteur principal ici, et la sonde ne garde que le plancher.

### La mesure doit d'abord faire ses preuves

« Relais fermé, aucune consommation » a deux lectures : le thermostat est ouvert (ballon plein), ou la mesure ne regarde pas le bon circuit (mauvais binding, capteur mort, relais qui n'a pas collé). Dans un seul cycle, les deux sont indiscernables.

La recette refuse donc de conclure tant qu'elle n'a pas vu la résistance tirer **au moins une fois** au moins la moitié de sa puissance nominale. Une fois le canal validé (`powerProven`, persistant), une chute à zéro devient digne de confiance — y compris sur un cycle qui démarre déjà coupé.

L'asymétrie est voulue : conclure « plein » à tort laisse la maison sans eau chaude, refuser de conclure laisse seulement un relais fermé sur un circuit qui ne consomme rien.

**Conséquence pratique** : la mesure doit porter sur le chauffe-eau lui-même. Un compteur général ne convient pas — après la coupure du thermostat, la consommation résiduelle du logement reste au-dessus de `cutoffPower` et la coupure ne serait jamais vue.

## Le cycle nocturne apprend sa durée

En mode `late` (par défaut) la chauffe démarre à `hcEnd − durée estimée` : elle **finit** quand la plage se ferme, donc l'eau est au plus chaud au réveil et passe le moins de temps possible à refroidir dans le ballon.

L'estimation part de `hcEstimate` (4 h par défaut) puis se corrige :

- cycle terminé par une coupure du thermostat → lissage vers la durée mesurée + 20 min de marge ;
- plage fermée sans jamais atteindre la coupure → l'estimation grandit de 45 min (on sait seulement que la vérité est *plus longue*).

**L'apprentissage exige une mesure de puissance validée.** Sans elle, `hcEstimate` est utilisée telle quelle, indéfiniment : c'est elle qui détermine la chauffe de chaque nuit. Dans ce cas, voir large. Surestimer ne coûte que quelques cycles de régulation du thermostat du ballon en tarif creux ; sous-estimer donne de l'eau tiède au réveil, tous les jours, sans rien pour le corriger.

## Plafond physique sur le surplus

En mode compteur général, renseigner aussi le compteur de production active un garde-fou : **on ne peut pas injecter plus qu'on ne produit**. Le surplus est plafonné à la production instantanée, et un écart aberrant déclenche un avertissement dans le journal.

C'est la protection contre le scénario coûteux : une pince mal orientée ou une convention de signe inversée fait lire « j'injecte 3 kW » alors qu'on soutire — et la recette allumerait 2,2 kW en heure pleine. Avec le plafond, production nulle signifie surplus nul, quoi que raconte le compteur.

## Anti-oscillation solaire

Dès que le relais se ferme, le chauffe-eau mange 2,2 kW et l'injection tombe à zéro — un asservissement naïf se couperait aussitôt. La loi de commande **réinjecte la consommation du chauffe-eau dans le surplus** tant qu'il tourne pour cette raison, et les deux fronts sont temporisés (`surplusStartDelay` / `surplusStopDelay`) pour encaisser les passages nuageux.

## Modes

Pastille cliquable sur la ligne de la recette : **Auto** → **Boost** (chauffe jusqu'à coupure du thermostat, puis retour en auto) → **En pause** (aucun ordre envoyé).

## Dégradations gracieuses

| Configuration | Comportement |
| --- | --- |
| Pas de sonde (`tempKey` vide) | Plancher désactivé, HC + solaire fonctionnent |
| Pas de mesure de puissance (`powerKey` vide) | Pas de détection de coupure : les cycles sont bornés par la plage et `maxCycle` |
| Sonde qui remonte peu | Jugée sur son âge réel (`tempMaxAge`, 2 h par défaut), pas sur le flag `stale` de Sowel (15 min) : un ballon de plusieurs centaines de litres ne change pas de température entre deux remontées espacées |
| Sonde muette au-delà de `tempMaxAge` | Plancher suspendu, avertissement dans le journal, reprise automatique au retour de la sonde |
| Mesure de puissance périmée | Traitée comme absente — la détection de coupure exige une valeur vivante |
| Chauffe-eau allumé à la main | La recette se retire et n'envoie plus d'ordre jusqu'à extinction |
| Redémarrage de l'instance | Le cycle en cours reprend avec son heure de départ d'origine, le relais n'est pas interrompu |

## Développement

```bash
npm install
npm test
npm run build
```

Release : pousser un tag `vX.Y.Z` — le workflow GitHub construit et publie `sowel-recipe-water-heater-smart-X.Y.Z.tar.gz`. La version doit être identique dans `manifest.json`, le tag et le nom de l'archive.

## Licence

AGPL-3.0
