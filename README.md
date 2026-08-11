# sowel-recipe-water-heater-smart

> **Publier une version** : bumper `manifest.json` + `package.json`, committer, puis `git tag vX.Y.Z && git push origin vX.Y.Z`. Le workflow `Release` teste, build, empaquette et crée la release GitHub. Ne pas lancer `gh release create` à la main : la commande crée aussi le tag, ce qui déclenche le workflow, qui trouvait alors sa propre release déjà là et échouait.

Recette Sowel pour piloter un **chauffe-eau électrique** derrière un simple relais marche/arrêt (Zigbee, Tasmota, …), sans consigne de température : c'est le thermostat mécanique du ballon qui décide de la température finale, la recette décide seulement **quand** la résistance a le droit de consommer.

## Ce que ça fait

Trois raisons de chauffer, par priorité décroissante :

| Priorité | Motif | Déclencheur | Arrêt |
| --- | --- | --- | --- |
| 1 | **Plancher d'eau chaude** | Sonde bas de ballon sous `minTemp` | `rescueTemp` atteinte, ou coupure du thermostat |
| 2 | **Heures creuses** | Fenêtre HC, cycle calé en fin de plage | Coupure du thermostat, ou fin de plage |
| 3 | **Surplus solaire** | Réservation accordée par l'arbitre Sowel | Réservation révoquée, ou coupure du thermostat |

Le plancher passe avant tout : au gîte, une série de douches en pleine journée vide le ballon hors heures creuses et sans soleil — la recette rechauffe quand même, le prix du kWh ne vaut pas de l'eau froide.

Le surplus est recevable **partout où le cycle heures creuses ne tourne pas déjà**, y compris à l'intérieur de la plage HC. Sur une plage nocturne ça ne change rien — personne n'injecte à 23 h. Sur une plage HC d'après-midi (les créneaux Enedis de la mi-journée) c'est l'inverse : refuser des watts gratuits pour attendre des watts pas chers, dans les mêmes heures, n'a pas de sens.

## Détection « ballon plein »

Le ballon n'expose pas de consigne haute exploitable : son thermostat s'ouvre tout seul quand l'eau est chaude. Ça se voit sur la **puissance mesurée**, qui s'effondre de ~2,2 kW à ~0 W alors que le relais est toujours fermé. Maintenu pendant `cutoffDelay`, ça vaut « ballon plein » → le relais s'ouvre et le cycle sert à affiner l'estimation de durée.

La sonde du bas ne peut pas jouer ce rôle : par stratification, elle lit froid pendant que le haut du ballon est à 60 °C. C'est exactement pour ça que la puissance est le capteur principal ici, et la sonde ne garde que le plancher.

### Combien de temps le ballon reste réputé chaud

Une fois la coupure constatée, la recette pose un verrou « ballon plein ». Sa durée dépend de ce qui peut le contredire :

- **avec une sonde vivante** — `tankFullMemory`, 12 h par défaut. La sonde est relue à chaque tick contre la température enregistrée au moment de la coupure : un puisage fait chuter le bas du ballon de plusieurs degrés et libère le verrou immédiatement, les pertes statiques finissent par le libérer toutes seules. C'est ce qui évite de refermer le relais à 3 h du matin sur un ballon que le soleil a porté au thermostat à 15 h ;
- **sans sonde, ou sonde périmée** — 2 h, comme avant. Plus rien ne contredit le verrou, donc il expire à l'aveugle. La recette préfère chauffer un ballon déjà chaud (le thermostat la coupe en quelques minutes) que sauter un cycle sur une hypothèse que personne ne vérifie.

L'échéance est publiée dans l'état de l'instance (`tankFullUntil`) : un cycle nocturne sauté est la chose la plus surprenante que fasse cette mémoire, elle dit donc quand elle s'arrête.

### La mesure doit d'abord faire ses preuves

« Relais fermé, aucune consommation » a deux lectures : le thermostat est ouvert (ballon plein), ou la mesure ne regarde pas le bon circuit (mauvais binding, capteur mort, relais qui n'a pas collé). Dans un seul cycle, les deux sont indiscernables.

La recette refuse donc de conclure tant qu'elle n'a pas vu la résistance tirer **au moins une fois** au moins la moitié de sa puissance nominale. Une fois le canal validé (`powerProven`, persistant), une chute à zéro devient digne de confiance — y compris sur un cycle qui démarre déjà coupé.

L'asymétrie est voulue : conclure « plein » à tort laisse la maison sans eau chaude, refuser de conclure laisse seulement un relais fermé sur un circuit qui ne consomme rien.

**Conséquence pratique** : la mesure doit porter sur le chauffe-eau lui-même. Un compteur général ne convient pas — après la coupure du thermostat, la consommation résiduelle du logement reste au-dessus de `cutoffPower` et la coupure ne serait jamais vue.

## Les heures creuses viennent de Sowel, et de nulle part ailleurs

La recette **ne propose aucun champ d'horaires**. Les heures creuses sont saisies une fois sous **Réglages → Administration → Tarif d'énergie**, et lues à chaque évaluation via `ctx.helpers.getTariff()` (Sowel ≥ 1.36, spec 138).

C'est délibéré : un second endroit où saisir les mêmes heures est un second endroit où elles peuvent être fausses, et la divergence serait invisible — la recette continuerait de chauffer sur d'anciens horaires longtemps après la modification de la page tarifs.

Conséquences :

- `validate()` refuse de créer l'instance si aucun tarif n'est configuré, en indiquant où le faire. Le problème se voit au moment du réglage, pas à 3 h du matin.
- Modifier la page tarifs prend effet immédiatement, sans toucher à l'instance.
- Si le tarif ne couvre pas la journée en cours, la chauffe nocturne est simplement sautée pour ce jour-là, et journalisée. La chauffe de secours et le solaire continuent.
- Si plusieurs plages creuses sont déclarées (nuit + midi), la recette prend **la plus longue** — celle qui a la place pour une chauffe complète.

## Le cycle nocturne apprend sa durée

En mode `late` (par défaut) la chauffe démarre à `hcEnd − durée estimée` : elle **finit** quand la plage se ferme, donc l'eau est au plus chaud au réveil et passe le moins de temps possible à refroidir dans le ballon.

L'estimation part de `hcEstimate` (4 h par défaut) puis se corrige :

- cycle terminé par une coupure du thermostat → lissage vers la durée mesurée + 20 min de marge ;
- plage fermée sans jamais atteindre la coupure → l'estimation grandit de 45 min (on sait seulement que la vérité est *plus longue*).

**Un cycle de moins de 30 minutes n'enseigne rien.** Un simple appoint sur un ballon déjà chaud atteint le thermostat en quelques minutes et ne dit rien de la durée d'une chauffe complète — mais la durée seule ne permet pas de distinguer les deux. Lisser un cycle de 10 min ferait tomber une estimation de 3 h à 2 h, et deux journées ensoleillées d'affilée suffiraient à ce que le calage HC ne couvre plus jamais une vraie chauffe.

**L'apprentissage exige une mesure de puissance validée.** Sans elle, `hcEstimate` est utilisée telle quelle, indéfiniment : c'est elle qui détermine la chauffe de chaque nuit. Dans ce cas, voir large. Surestimer ne coûte que quelques cycles de régulation du thermostat du ballon en tarif creux ; sous-estimer donne de l'eau tiède au réveil, tous les jours, sans rien pour le corriger.

## Le surplus solaire est arbitré par Sowel, pas par la recette

La recette **ne lit aucun compteur**. Elle ouvre une *réservation* auprès de l'arbitre de capacité du cœur (spec 140, Sowel ≥ 1.39) et chauffe tant que la réservation est accordée.

Ce n'est pas un rangement cosmétique. Une recette qui pilote sur son propre seuil d'injection **consomme le signal qu'elle observe** : fermer le relais tue l'injection qui justifiait de le fermer. On ne s'en sort qu'en réinjectant sa propre consommation dans le calcul — ce qu'une recette seule peut faire correctement, et deux non. À deux, les mêmes 800 W de surplus font démarrer le chauffe-eau *et* la pompe piscine, l'injection s'effondre, les deux s'arrêtent, et ça recommence.

L'arbitre est l'unique lecteur du compteur. Il fait cette comptabilité une fois pour toutes les charges, et distribue le surplus dans **l'ordre de priorité choisi par l'utilisateur**.

### Ce qu'il faut régler, et où

Rien dans le formulaire de la recette. Deux choses côté Sowel, une seule fois :

1. **Équipements → le chauffe-eau → Gestion de l'énergie** : activer, classe `deferrable`, puissance nominale de la résistance.
2. **Réglages → Administration → Énergie** : activer l'arbitrage, et placer le chauffe-eau dans la liste de priorité.

Si l'une des deux manque, le journal de l'instance le dit une fois, en nommant la page. Le reste de la recette continue : **heures creuses + plancher est un mode complet, pas un mode dégradé** — c'est aussi le mode de toutes les maisons sans photovoltaïque.

### Ce que la recette dit à l'arbitre

| Ce qu'elle déclare | Valeur | Pourquoi |
| --- | --- | --- |
| `watts` | Puissance du profil énergie (repli : slot `heaterPower`, puis 2200 W) | Dimensionne la décision d'enclenchement |
| `toleratedImportW` | 10 % de la puissance, soit 220 W sur un 2,2 kW (slot `toleratedImport` pour forcer) | Une résistance est tout-ou-rien : attendre que l'injection couvre 2,2 kW *entièrement* refuse l'essentiel du surplus d'une journée pour les derniers pour-cent |
| `slack` | `none` / `some` / `high` selon l'état du ballon | La seule chose que la liste de priorité statique ne peut pas savoir |

**`slack` ne fait que descendre dans la liste, jamais monter.** C'est ce qui le rend inoffensif : personne n'a intérêt à mentir vers le bas. Un ballon à 55 °C avec les heures creuses dans six heures se met en `high` et laisse passer la pompe piscine, alors même que l'utilisateur l'a classé au-dessus. Près du plancher, ou en boost, ou quand le cycle anti-légionelle est dû, il repasse en `none` — et `none` est la seule valeur autorisée à préempter les charges du dessous.

### La réservation reste ouverte pendant les chauffes obligatoires

Quand le plancher ou le cycle heures creuses ferme le relais, la recette **garde sa réservation ouverte** au lieu de la rendre (règle auteur 5 de la spec). Une charge qui tourne sans réservation est un trou dans le surplus de l'arbitre : il compte ses 2,2 kW comme de la consommation de fond et révoque la pompe piscine sans comprendre pourquoi. Avec la réservation ouverte, l'arbitre peut l'accorder à coût nul — la consommation est déjà dans le compteur — et ses comptes redeviennent justes pour tout le monde.

### Ce que publie l'instance

`surplusClaim` (`pending` / `granted` / la raison du refus), `availableSurplus` (le surplus disponible vu par l'arbitre) et `surplusSlack`. Les anciens `surplus`, `solarStartAt` et `solarStopAt` ont disparu avec les seuils : « pourquoi ça ne chauffe pas en plein soleil ? » se lit maintenant sur une ligne, et le détail complet est dans le journal des décisions de **Énergie → En direct**.

## Modes

Pastille cliquable sur la ligne de la recette : **Auto** → **Boost** (chauffe jusqu'à coupure du thermostat, puis retour en auto) → **En pause** (aucun ordre envoyé).

## Dégradations gracieuses

| Configuration | Comportement |
| --- | --- |
| Bindings du chauffe-eau | Trouvés tout seuls : alias conventionnel (`water_temperature`, `power`), sinon n'importe quel binding de la bonne catégorie. Les slots ne servent qu'à forcer un autre choix. |
| Capteur ajouté après coup | Résolu à chaque lecture : brancher la mesure de puissance plus tard active la détection de coupure sans rééditer ni redémarrer l'instance |
| Pas de sonde de température | Chauffe de secours désactivée, HC + solaire fonctionnent |
| Arbitrage désactivé, chauffe-eau non déclaré, ou maison sans PV | Pas de chauffe sur surplus, dit une fois dans le journal en nommant la page à ouvrir. HC et plancher intacts |
| Sowel < 1.39 | Idem : `ctx.helpers.energy` absent, la recette n'en dépend jamais pour fonctionner |
| Réservation révoquée (nuage, préemption, compteur muet) | Le relais s'ouvre, la réservation **reste en file** côté cœur : rien à redemander quand le soleil revient |
| Pas de mesure de puissance | Pas de détection de coupure : les cycles sont bornés par la plage et `maxCycle` |
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
