# Justifications des commits de correction de l'ontologie

Audit indépendant des 21 commits de fix compris entre `db88755` (exclu) et `a2490a2` (exclu), hors commit de merge `c8ace4b`. Chaque commit a été analysé par un agent indépendant, en lecture seule, avec la méthode suivante : diff complet (`git show`), comparaison des états avant/après, greps d'exhaustivité sur tout le dépôt, et validation mécanique par parsing RDF (rdflib), avec comptage de triples et, quand pertinent, test d'isomorphisme de graphes.

**Verdict global : les 21 fixs sont tous jugés « Justifié ». Aucun n'a été classé douteux ou non justifié.** Deux erreurs corrigées se sont même avérées être des régressions de commits amont identifiés (voir 638ebaf et 1f7af93).

---

## Rectifications complémentaires — état d'application (24 juillet 2026)

Les reliquats détectés par l'audit ont été traités dans une passe de corrections complémentaires : **uniquement des rectifications de défauts existants, rien de nouveau**, chacune complétant un commit de la série auditée. Chaque point a été re-vérifié par un agent indépendant en lecture seule avant application (état exact, unicité des ancres textuelles, hiérarchies de classes, cohérence des inverses OWL), puis les éditions ont été appliquées par ancres exactes (19 éditions, chacune matchant exactement une fois) et validées par parsing rdflib : **16 341 → 16 371 triples, delta +30 exactement conforme à l'attendu** (−2 suppressions de punning, +32 pour les structures d'union), zéro occurrence résiduelle des fautes corrigées.

### ✅ Appliquées

1. **« receipent » → « recipient »** (`DigitalReference.ttl`, label l. 9430 de `ecsel-dr-CO2Savings:distance_between_sender_and_recipient`) — complète 7c2c733. Vérifié : c'était l'unique occurrence restante du dépôt ; l'IRI voisine était déjà correcte.
2. **Déclarations vestigiales de punning supprimées** — `owl:cardinality rdf:type owl:AnnotationProperty .` et `owl:maxCardinality rdf:type owl:AnnotationProperty .` (l. 153–158, avec leurs commentaires `###`) — complète 262e92c et 35cd9f8. Vérification préalable programmatique : toutes les occurrences restantes de ces deux termes (14 + 6) sont dans des restrictions bien formées (`[ rdf:type owl:Restriction ; owl:onProperty … ]`) — plus aucun usage en annotation, suppression sûre.
3. **`README.md` mis à jour** — les 4 lignes `@prefix` fantômes (`ecsel-dr-AH#`, `ecsel-dr-ORG#`, `ecsel-dr-PWR#`, `ecsel-dr-SCP#`) remplacées par les 6 vrais préfixes déclarés dans le TTL (`ecsel-dr-Cloud-AH`, `ecsel-dr-Organization`, `ecsel-dr-Organization-ORG`, `ecsel-dr-Power-PWR`, `ecsel-dr-Planning-DF`, `ecsel-dr-Planning-SCP`) — complète aec4dc0 et 56501c7.
4. **Les 8 domaines/ranges multi-valués du module PMV convertis en `owl:unionOf`** — `follows` (domaine + range), `is_predecessor_of` (domaine + range), `creates_event` (domaine), `is_created_by` (range), `leads_to_rule` (domaine), `is_assigned_to` (range) — complète 08d67ed, format validé octet par octet contre le style de ce commit. Un scan systématique a confirmé qu'il n'existait exactement que ces 8 déclarations multi-valuées dans le module PMV, et les 3 paires d'inverses (`follows`/`is_predecessor_of`, `creates_event`/`is_created_by`, `is_assigned_to`/`leads_to_rule`) restent en miroir exact après conversion. Nuance assumée pour `creates_event`/`is_created_by` : la conversion élargit légèrement le domaine/range effectif (de `Task ⊔ Process_Interface` à tout `Modelling_Function_Object`) — élargissement voulu pour l'homogénéité avec les connecteurs EPC frères, `Modelling_Function_Object` n'ayant précisément que ces deux sous-classes.
5. **Commentaire de `Demand_Fulfillment` dédoublonné** — la seconde variante de la phrase dupliquée (« It represents the interface between the supply chain and its external customers. ») supprimée (la première, conservée, porte la subordonnée informative « ensuring that demand is met… ») ; accent aigu `customer´s` (U+00B4) → `customer's` — complète 7f5761d.
6. **« amlification » → « amplification »** (commentaire de `ecsel-dr-Power-PWR:makes_switching`, l. 7202) — reliquat signalé dans l'audit de 20a0472 (troisième variante fautive, dans un commentaire, pas un IRI) — complète 20a0472.
7. **Teinte « power » injustifiée retirée de 4 définitions** du lot amont 203332c, un seul mot changé par définition (précédent : 1f7af93/`Actuator_Device`) : `Bridge` (suppression de « power-system »), `Hub` (suppression de « power-domain »), `Proxy` (suppression de « power-system »), `Industry_PC` (« supervise power processes » → « supervise industrial processes »). **Abstentions motivées après vérification** : `Microcontroller` non touché — ce n'est pas une classe AT mais `dr:Microcontroller` avec un ancrage réel dans le lobe Power (`rdfs:subClassOf ecsel-dr-Power-PWR:Semiconductors`, contexte motor-control/drive) : la teinte power y est défendable ; `Autonomously_Guided_Vehicle` et `Electric_Drive` non touchés — « power » y est légitime (alimentation embarquée du véhicule, électronique de puissance intrinsèque à un entraînement).

### ⏸️ Non appliquées (décision utilisateur requise)

8. **Coquilles dans des IRIs** — `ecsel-dr-PMV:is_responsible_for_fuction` (l. ~5977) et l'IRI anormale `<http://www.w3id.org/ecsel-dr-PWR#Triode/Constant_Resistance_Region>` (mauvais namespace : ses voisines sont dans `ecsel-dr-Power-PWR#`). Un renommage d'IRI n'est pas « mineur » : il casse les consommateurs externes éventuels (`w3id.org` est résolvable publiquement). Si décidé : renommer **et** laisser un pont (`owl:deprecated true` sur l'ancienne IRI + `owl:equivalentClass`/`owl:equivalentProperty` vers la nouvelle).
9. **Tombstones rétroactives pour les renommages déjà faits** (20a0472, c86f1f8) : complets et sûrs à l'intérieur du dépôt, mais si une compatibilité externe est requise, ajouter des entités dépréciées pour `Amplication_Switching_Device`, `amplication_switching_device_has_property` et `AH_Application_Servcice_IDD`.

### Points examinés et volontairement non retenus

Hors périmètre ou discutables — aucune action : le rattachement de `Aggregated_Capacity` à `dr:Capacity` (sa définition ACG rend le rattachement discutable), `Capacity_Bottleneck`/`Bottleneck_Resource` (erreurs de catégorie préexistantes distinctes), le domaine de la propriété `level` (le commentaire parle des vertices, le domaine dit `Edge` + `Planning_Situation`), la modélisation de `location` en DatatypeProperty, les ~186 autres domaines/ranges multi-valués hors modules déjà traités (sosa, CO2Savings, OOSMP…) qui demanderaient une campagne dédiée, la variante britannique « demand fulfilment » (l. ~22685 — graphie valide, pas une faute), et « Infineon´s »/« Infoneon » (l. ~20990, commentaire du TLI4970 — relevé en passant, non traité dans ce lot).

---

## Justifications commit par commit

*(ordre chronologique, du plus ancien au plus récent)*

### c86f1f8 — Fix typo in Arrowhead class name: Servcice -> Service

**Verdict : Justifié**

**Ce que fait le commit.** Il renomme, dans `DigitalReference.ttl`, la classe OWL `<http://www.w3id.org/ecsel-dr-Cloud-AH#AH_Application_Servcice_IDD>` en `...#AH_Application_Service_IDD` et corrige le `rdfs:label` correspondant (« AH Application Servcice IDD » → « AH Application Service IDD »). Le diff de 94 lignes est trompeur : seules 3 lignes (~18896–18899) portent la correction réelle ; les ~90 autres sont une normalisation de fins de ligne LF→CRLF (vérifiée avec `cat -A`), sans changement de contenu (`git show -w` ne montre que 24 lignes, un seul hunk).

**Preuves.**
- Le typo existait réellement : `git grep "Servcice"` à l'état avant renvoie 3 lignes ; après le commit et à HEAD : zéro occurrence. Le typo est ancien (introduit vers les commits `8920b95`/`ee5bba9`).
- La correction est la bonne, pas juste plausible : la propre `skos:definition` de la classe (non modifiée) écrivait déjà « *AH Application Service IDD (Application Service Interface Design Description)* » ; toutes les classes sœurs suivent le motif correct (`AH_Application_Service`, `AH_Application_Service_SD`, `AH_Core_Service_IDD`, `AH_Orchestration_Service_IDD`, etc.).
- Aucune référence cassée : validation rdflib — **16 284 triples avant = 16 284 après** ; l'ancienne IRI apparaissait dans 4 triples uniquement comme sujet, jamais comme objet. Aucune occurrence dans les autres fichiers du dépôt.
- Pas de fusion accidentelle : le bon nom `AH_Application_Service_IDD` n'existait pas avant le commit.

**Réserves/risques.** Renommage d'une IRI publiée sans `owl:deprecated`/alias (risque externe très faible : classe récente, jamais référencée même en interne). Churn CRLF non mentionné dans le message (inoffensif). Incohérence textuelle préexistante non aggravée : la définition dit « subclass of AH Service Documentation Document » alors que le `rdfs:subClassOf` réel est `Interface_Design_Description_IDD`.

---

### 6f5deb8 — Remove duplicate quality property with misspelled 'qualty' namespace

**Verdict : Justifié**

**Ce que fait le commit.** Il supprime 4 lignes de `DigitalReference.ttl` : la déclaration de l'ObjectProperty `<http://www.w3id.org/ecsel-dr/qualty/is_executed_on>` (commentaire + `rdf:type owl:ObjectProperty` + `rdfs:domain` + `rdfs:range`). Rien d'autre.

**Preuves.**
- Doublon strict, aucune information perdue : la propriété conservée `ecsel-dr/quality/is_executed_on` et la propriété supprimée `ecsel-dr/qualty/is_executed_on` ont exactement le même domaine (`ecsel-dr/quality/Failure_Analysis`) et le même range (`digital-reference/quality/Product_Instance`) ; ni l'une ni l'autre ne porte de labels, commentaires ou autres annotations.
- « qualty » est bien une coquille : l'inventaire des namespaces `w3id.org/ecsel-dr/<module>/` ne donne qu'un seul module de cette forme, `quality` (45 occurrences) ; même dans le bloc supprimé, le domaine référençait le namespace correctement orthographié.
- Aucune référence cassée : `git grep "qualty"` à l'état avant ne trouve que les lignes de la déclaration supprimée ; zéro occurrence restante après.
- Vérification par parsing rdflib : 16 284 triples avant (dont 3 avec « qualty ») → 16 281 après, 0 mention ; exactement les 3 triples du doublon retirés.
- Origine : `git log -S "qualty"` montre que la coquille vient du commit `e0203a4`, qui ajoutait les deux variantes dans le même diff — schéma typique d'un ajout dupliqué avec faute de frappe.

**Réserves/risques.** Aucun. Point théorique négligeable : un consommateur externe de l'IRI fautive perdrait la déclaration — rien n'en dépend, et conserver une IRI fautive serait pire.

---

### b62f9a4 — Reassign RAMI40 Submodel to System lobe instead of supply-chain Stocks

**Verdict : Justifié**

**Ce que fait le commit.** Une seule ligne modifiée : le parent de la classe `ecsel-dr-RAMI40:Submodel` passe de `<http://www.w3id.org/ecsel-dr-Planning-SCP#Stocks>` (module planification supply chain) à `dr:System_Lobe`. Commentaire et label conservés.

**Preuves.**
- L'ancien axiome était sémantiquement absurde : dans RAMI 4.0 / Asset Administration Shell (DIN SPEC 91345, IEC 63278), un Submodel est un conteneur d'informations de l'actif I4.0. Le dépôt le confirme : `Submodel` a pour commentaire « Describe the different types of data related to the I4.0 asset » ; `has_submodel` et `has_data` relient `Admin_Shell` à `Submodel` ; `View` mentionne « associated to the Administration Shell via the Submodels ». Or `Planning-SCP:Stocks` est défini « A supply of something for use or sale » et est `rdfs:subClassOf ssn:Stimulus` : l'axiome faisait de tout Submodel (et par héritage `Structure`, `MES_Connection`, `Sensor_Measurement`, `Energy_Efficiency`, `Transport_Interface`) « un approvisionnement destiné à la vente » et un stimulus SSN.
- Le nouveau parent est cohérent : toutes les autres classes racines RAMI40 (`Admin_Shell`, `Asset`, `Date`, `Dimension`, `I_4.0_Component`, `Measure`, `Semantic_Expression`, `Sensor`, `Standard`, `Standard_Organization`, `Version`, `View`) sont rattachées à `dr:System_Lobe`, dont le commentaire décrit précisément la modélisation I4.0/Admin Shell.
- Aucun lien légitime détruit : le bloc avant ne contenait que subClassOf + comment + label ; aucun individu de `Submodel`, aucune dépendance à l'inférence `Submodel ⊑ Stocks`.
- Origine : au commit initial `47f6888`, `Submodel` n'avait aucune superclasse ; le rattachement à Stocks est apparu lors d'un remplacement massif du fichier (`aa1598e`, ~25 000 lignes), sans justification traçable.

**Réserves/risques.** Divergence assumée avec l'ontologie amont (c'est le but de la branche de corrections). L'alternative « composition sous Admin_Shell » existe déjà via `has_submodel` ; le rattachement au lobe suit la convention du dépôt.

---

### 262e92c — Remove two orphan cardinality restrictions with no property

**Verdict : Justifié**

**Ce que fait le commit.** Il supprime 4 lignes dans `DigitalReference.ttl` : deux nœuds anonymes autonomes de la forme `[ owl:cardinality "1"^^xsd:nonNegativeInteger ] .`, situés à la fin de la section des individus (~ligne 25316) — restes typiques d'export Protégé.

**Preuves.**
- Orphelines, vérifié par parsing rdflib avant/après : exactement 2 sujets porteurs de `owl:cardinality` sans `owl:onProperty` ; chacun ne porte qu'un seul triplet, pas de `rdf:type owl:Restriction`, et n'est référencé par aucun autre triplet. Après : 0.
- Irréférençables par construction : la syntaxe Turtle `[ … ] .` crée un nœud blanc anonyme utilisé uniquement comme sujet ; aucune information exploitable n'est perdue.
- Propriété manquante indevinable : aucun rattachement entrant, aucun contexte sémantique — « réparer » aurait exigé d'inventer une propriété ET une classe porteuse. La suppression était la seule option honnête.
- Cohérence syntaxique préservée : les deux versions parsent ; 16 281 → 16 279 triplets, soit exactement les 2 orphelins ; toutes les occurrences restantes d'`owl:cardinality` sont dans des restrictions complètes avec `owl:onProperty`.

**Réserves/risques.** Résidu mineur non traité : la déclaration `owl:cardinality rdf:type owl:AnnotationProperty .` (ligne ~154) subsiste — vestige de punning Protégé désormais inutile (cf. rectification n° 2 ci-dessus). Ne remet pas en cause le commit.

---

### 35cd9f8 — Turn malformed cardinality into label on has_process_input property

**Verdict : Justifié**

**Ce que fait le commit.** Une seule ligne (7101) : sur la propriété objet `ecsel-dr-Power-PWR#has_process_input`, le prédicat `owl:maxCardinality "has process input"@en` est remplacé par `rdfs:label "has process input"@en`.

**Preuves.**
- La cardinalité était malformée à double titre : `owl:maxCardinality` n'a de sens que sur un nœud `owl:Restriction` (avec `owl:onProperty`), jamais directement sur une ObjectProperty ; et sa valeur doit être un entier — ici c'était la chaîne anglaise qui est mot pour mot le libellé attendu. **Aucune sémantique de cardinalité n'a été perdue** : il n'y avait aucune valeur numérique à préserver.
- Le triple n'avait déjà aucune sémantique OWL : le fichier déclare `owl:maxCardinality rdf:type owl:AnnotationProperty .` (punning Protégé émis précisément quand ce vocabulaire est mal employé).
- Cohérence avec les voisines : la propriété miroir `has_process_output` porte exactement `rdfs:label "has process output"@en` ; `has_process_input` était la seule sans label. Le fix rétablit la symétrie entrée/sortie.
- Les cardinalités légitimes du fichier sont toutes de la forme `"1"^^xsd:nonNegativeInteger` dans des blocs `owl:Restriction` — la ligne 7101 était un cas isolé et aberrant.
- Validité : parsing rdflib OK (16 279 triples) ; la propriété porte désormais type, domaine, range et label — un `rdfs:label` sur une propriété est parfaitement standard.
- Alternatives écartées à raison : supprimer aurait perdu le label (la propriété n'en avait aucun autre) ; réparer en vraie restriction aurait exigé d'inventer une valeur numérique absente de la source.

**Réserves/risques.** Déclarations de punning vestigiales restantes (cf. rectification n° 2). Purement théorique : si l'auteur d'origine voulait vraiment une contrainte de cardinalité, elle reste absente — mais rien ne permet de la reconstituer.

---

### 7c2c733 — Fix spelling in labels and comments across lobes

**Verdict : Justifié** (fix très légèrement incomplet : une occurrence de la même faute subsiste)

**Ce que fait le commit.** 15 lignes modifiées dans `DigitalReference.ttl`, uniquement des littéraux d'annotation (`rdfs:comment`, `rdfs:label`, `skos:definition`, `skos:altLabel`). Le fichier parse (rdflib : 16 279 triplets). Corrections vérifiées une à une :

| Original | Corrigé | Emplacement | Légitime ? |
|---|---|---|---|
| funcionts | functions | comment, ORG `has a contributor` | Oui |
| FuncitonObject | FunctionObject | comment, `ecsel-dr-PMV:diagramed_on_model` | Oui |
| exectu | execute | altLabel, `PMV:is_executed_by_function` | Oui |
| ona | one | comment, `PWR#has_information_object` | Oui |
| multiplicatoin | multiplication | label, `PWR#has_power_loss_calculated_by_multiplication_of` | Oui |
| Acutator | Actuator | label, `ecsel-dr-AT:Actuator_Device` | Oui |
| Reciepent / Receipent | Recipient | labels, `CO2Savings:Distance_Between_Sender_And_Recipient(_Km)` | Oui |
| fuctions, suppyl | functions, supply | comment, `ORG#Central_Function` | Oui |
| en entity | an entity | comment, `ecsel-dr-PROD:Organization` | Oui |
| Orde | Order | définition, `Planning-DF#Order_Repromising_Plan` | Oui |
| increaseing (×2) | increasing | comments, `PWR#Control_Method` et `PWR#Voltage_Controlled` | Oui |
| Lenght | Length | label, `PWR#Length` | Oui |
| Sourcet o | Source to | comment, `PWR#Voltage_Controlled` | Oui |
| Andmin, elecrtonically | Admin, electronically | comment, `ecsel-dr-RAMI40:Admin_Shell` | Oui |

**Preuves.**
- Aucun IRI modifié : extraction de toutes les URL des lignes du diff → vide. Le commit a eu raison de **ne pas** toucher les IRIs eux-mêmes fautifs (`is_responsible_for_fuction`, `Amplication_Switching_Device` — ce dernier traité séparément par 20a0472).
- Aucun faux ami : pas de terme technique légitime, nom propre ou variante UK/US corrigé à tort ; « diagramed » (US valide) laissé tel quel, à juste titre.
- Chaque correction est cohérente avec l'IRI de l'entité correspondante.
- Intégrité syntaxique validée par parsing.

**Réserves/risques.** (1) Une occurrence de « receipent » subsiste à la ligne 9430 (cf. rectification n° 1). (2) Coquilles restantes dans des IRIs, hors périmètre légitime (cf. rectification n° 7). (3) Détails cosmétiques non traités (espaces doubles), sans importance.

---

### 7f5761d — Fix Fulfillement spelling and stray quote in Demand Fulfillment texts

**Verdict : Justifié**

**Ce que fait le commit.** Corrige 4 occurrences de « Fulfillement » → « Fulfillment » (1 label de `dr:fulfilled_by_demand_fulfillment`, 1 label et 2 commentaires de `ecsel-dr-OM:Demand_Fulfillment`) et supprime un guillemet typographique orphelin (`”`, U+201D) au milieu d'un commentaire. Aucune IRI, aucun axiome.

**Preuves.**
- « Fulfillement » est bien une faute : l'anglais admet « fulfillment » (US) et « fulfilment » (UK), jamais « fulfillement » (croisement avec le français « -ement »).
- Cohérence avec les IRIs, déjà bien orthographiées et non modifiées (`ecsel-dr-OM#Demand_Fulfillment`, `dr:fulfilled_by_demand_fulfillment`) : le fix aligne les labels sur les IRIs. Parsing rdflib : même nombre de triples avant/après (16 279) — seules des valeurs littérales ont changé.
- Exhaustivité : 4 occurrences avant, **0** après, sur tout le dépôt.
- Le guillemet parasite était cosmétique, pas syntaxique : guillemet courbe à l'intérieur du littéral (Turtle ne délimite qu'avec `"` droits) ; les deux versions parsent. C'était un fermant sans ouvrant (reliquat de copier-coller) — suppression correcte ; les ~20 autres paires `“…”` du fichier, intentionnelles, n'ont pas été touchées, à raison.

**Réserves/risques.** Le commentaire corrigé contient toujours une phrase dupliquée (cf. rectification n° 5) ; `customer´s` avec U+00B4 (idem) ; une occurrence britannique « demand fulfilment » (ligne ~22685) reste incohérente avec l'US utilisé partout — graphie valide, pas une faute.

---

### 20a0472 — Rename Amplication to Amplification across Power lobe (typo in IRIs)

**Verdict : Justifié** (avec réserve sur la compatibilité externe)

**Ce que fait le commit.** 19 lignes modifiées dans `DigitalReference.ttl` : renomme la classe `<http://www.w3id.org/ecsel-dr-Power-PWR#Amplication_Switching_Device>` en `Amplification_Switching_Device`, la propriété `amplication_switching_device_has_property` en `amplification_switching_device_has_property`, le label de la classe et une mention dans le commentaire de `dr:Power_Lobe` ; les autres lignes sont les `rdfs:domain`/`rdfs:range` qui pointaient vers l'ancienne IRI.

**Preuves.**
- Renommage exhaustif : 19 occurrences de « amplication » avant (toutes dans ce seul fichier), **0 après**, 0 à HEAD. Diff exactement +19/−19.
- Aucune collision : l'IRI `Amplification_Switching_Device` n'existait pas avant ; après, 18 triples référencent la nouvelle IRI, 0 l'ancienne, 0 orphelin.
- Intégrité : les deux versions parsent (16 279 triples chacune — aucun triple perdu ni fusionné).
- Terme correct : « amplication » n'est pas un mot anglais. Le contexte le confirme : la classe est `owl:equivalentClass <...#SiC_MOSFET>` et `rdfs:subClassOf <...#Power_Device>` ; la propriété voisine s'appelle `amplified_by` ; les commentaires du module parlent d'« amplification » comme méthode de boost d'un convertisseur.

**Réserves/risques.** Les IRIs `w3id.org` sont publiques et résolvables : un consommateur externe référençant les anciennes IRIs est cassé silencieusement — pas de tombstone `owl:deprecated` + équivalence (cf. rectification n° 8). Risque modéré (la faute rend un usage externe improbable). Une troisième variante fautive « amlification » subsiste dans un commentaire (hors périmètre annoncé).

---

### 90b1f6e — Make location domain a union of Product and Planning_Element

**Verdict : Justifié**

**Ce que fait le commit.** Remplace, sur la propriété `ecsel-dr-PROD:location`, deux triples `rdfs:domain` séparés (`dr:Product` et `ecsel-dr-PROD:Planning_Element`) par un domaine unique anonyme `owl:unionOf ( dr:Product ecsel-dr-PROD:Planning_Element )`. Seul changement (5 insertions, 2 suppressions).

**Preuves.**
- Rappel OWL : plusieurs triples `rdfs:domain` s'interprètent en **conjonction (intersection)** — tout sujet est inféré membre de chacune des classes. L'intention manifeste (union) était mal encodée.
- Point décisif : les deux classes sont **explicitement disjointes** — `dr:Product … owl:disjointWith ecsel-dr-PROD:Planning_Element` (ligne 15404, préexistant). L'ancien domaine effectif était donc `Product ⊓ Planning_Element ≡ owl:Nothing` : toute utilisation de la propriété aurait rendu l'ontologie **incohérente**.
- Le nouveau `owl:unionOf` est syntaxiquement correct : vérifié rdflib (16 341 triples), un unique nœud de domaine typé `owl:Class`, collection bien formée aux deux membres attendus (les mêmes qu'avant, ni plus ni moins).
- Usage réel : la propriété n'est utilisée par aucune instance dans le dépôt — le bug était latent, le fix ne casse rien.

**Réserves/risques.** Hors périmètre : `location` reste une DatatypeProperty de range `xsd:string` alors que le commentaire décrit un lieu — une ObjectProperty serait plus propre, mais le commit ne prétendait pas traiter cela.

---

### a24dd46 — Make BMS property domains unions instead of empty intersections

**Verdict : Justifié**

**Ce que fait le commit.** Pour 4 propriétés objet du module BMS (`enables_CO2_savings`, `has_semiconductor`, `is_functional_block`, `is_part_of_battery`), remplace les déclarations multiples de `rdfs:domain` (= intersection) par un unique domaine anonyme `owl:unionOf` listant exactement les mêmes classes. Ranges inchangés (44 lignes modifiées).

**Preuves.**
- Diff exact vérifié sur les blobs (contrôle md5). Exemple : `is_part_of_battery` avait `rdfs:domain Battery_Management_System , Cells , Pack` ; après, un bnode `[ rdf:type owl:Class ; owl:unionOf ( … ) ]` avec les mêmes membres.
- Défaut réel : les classes sont des sœurs incompatibles (5 sous-classes sœurs de `Functional_Block` ; composants distincts BMS/Cells/Pack ; 3 sous-classes sœurs de `Battery_CO2_Savings`). Tout sujet aurait dû être instance de toutes à la fois. Le commentaire de `Lithium_Ion_Battery` (« the set of cells together, which is the battery pack, plus the battery management system ») confirme textuellement l'union comme intention pour `is_part_of_battery`.
- Correction syntaxique : les deux versions parsent (16 284 → 16 312 triplets, +28 exactement conforme au réencodage) ; chaque domaine après est un unique bnode `owl:Class` avec collection bien formée ; ensembles de classes préservés à l'identique ; ranges inchangés.
- Fix complet dans son périmètre : avant, exactement 4 propriétés BMS multi-domaines ; après, 0. Les 211 propriétés multi-domaines restantes sont hors module BMS (traitées par les commits frères 90b1f6e et 08d67ed pour leurs périmètres respectifs).

**Réserves/risques.** Message légèrement survendu : aucune classe BMS n'est dans un axiome de disjonction — les intersections n'étaient pas *formellement* vides, « seulement » sémantiquement absurdes. Impact nul en pratique (0 assertion ABox — aucune régression possible). Bizarrerie préexistante préservée fidèlement : pour `enables_CO2_savings`, le domaine est inclus dans le range.

---

### 08d67ed — Make Process EPC property domains and ranges unions instead of intersections

**Verdict : Justifié**

**Ce que fait le commit.** Dans le module `ecsel-dr-PMV` (modélisation EPC/ARIS), remplace pour 4 propriétés objet — `has_as_output`, `is_output_of`, `is_represented_by`, `represents` — les listes de plusieurs `rdfs:domain`/`rdfs:range` par un unique domaine/range anonyme `owl:unionOf`.

**Preuves.**
- Les intersections étaient sémantiquement absurdes : `Output` ⊑ `Process_Lobe` et `Technical_Term` ⊑ `Document` — l'intersection forçait toute valeur de `has_as_output` à être à la fois un output physique **et** un document. Les deux commentaires de la propriété décrivent explicitement **deux usages alternatifs** (« produces a physical or non-physical output » / « can have technical term(s) as output ») : l'union est manifestement la sémantique voulue.
- Pour `represents` : domaine avant = `Business_Process_Activity` ⊓ `Screen` (une activité métier qui serait aussi une transaction SAP) ; range avant exigerait qu'une `Task` soit simultanément un diagramme de flux entier. Les commentaires (« A aris:BPActivity is the graphical representation of a aris:VACD or aris:BPFlow ») confirment des cas d'usage distincts.
- Cas `has_as_output` côté domaine : `Task` ⊑ `Function`, donc l'intersection se réduisait à `Task` — non vide mais trop étroite (toute `Function` sujet aurait été inférée `Task`) ; l'union rétablit le domaine large voulu.
- Les `owl:unionOf` sont bien formés : parsing rdflib après commit (16 341 triplets, OK) ; chaque propriété a exactement un domaine et un range. **Cohérence des inverses vérifiée** : domaine de `has_as_output` = range de `is_output_of` et réciproquement ; idem `represents`/`is_represented_by`.

**Réserves/risques.** (1) Correction incomplète dans le module PMV : 8 occurrences multi-valuées restantes du même type, moins graves (cf. rectification n° 4) ; ~186 autres ailleurs dans l'ontologie, hors périmètre annoncé. (2) `Process_Lobe` et `Document` ne sont pas déclarés disjoints : absurdité de modélisation, pas insatisfiabilité formelle. (3) Légère sur-généralisation inhérente à l'union (p. ex. `Screen` → `Value_Added_Chain_Diagram` devient permis) — limite du mécanisme domain/range, pas une régression.

---

### 89156d3 — Remove wrong subproperty link from has_certification_level to has_contributor

**Verdict : Justifié**

**Ce que fait le commit.** Supprime une seule ligne : l'axiome `rdfs:subPropertyOf` faisant de `ecsel-dr-Organization-ORG:has_certification_level` une sous-propriété de `has_contributor`. Le reste de la définition (inverse, caractère fonctionnel, domaine, range, commentaire, label) est intact.

**Preuves.**
- Incompatibilité sémantique totale : `has_certification_level` a pour domaine `Company_Project` et range `Certification` (« Relation between a project and the certification that it has ») ; `has_contributor` a pour domaine `dr:Role` et range `unionOf(Division, Central_Function, Region)`. Aucun recouvrement ni subsomption (`Company_Project` et `Role` sont des classes sœurs sous `Organization_Lobe`). Avec le lien, un raisonneur aurait inféré pour chaque assertion que le projet est un `Role` et la certification une `Division`/`Central_Function`/`Region` — entailments erronés silencieux.
- Pas de pattern de masse : sur 369 axiomes `subPropertyOf` du fichier, ce lien vers `has_contributor` était **unique**. Les propriétés sœurs structurellement identiques (`has_category_level`, `has_project_status`, `has_training_level`, `has_work_package`) n'ont **aucun** parent — le lien était un outlier, pas une convention.
- Asymétrie révélatrice : l'inverse `is_certification_level_of` n'était **pas** sous-propriété de `is_contributor_of` ; une hiérarchie voulue est normalement miroir côté inverses — artefact d'édition typique (glisser-déposer accidentel dans Protégé).
- Origine : le lien date du tout premier import (`aa1598e`) et a survécu aux renommages ; jamais introduit délibérément dans un commit de modélisation identifiable.
- La suppression sèche est le bon remède : aucun parent alternatif plausible n'existe, et elle aligne la propriété sur ses voisines.

**Réserves/risques.** Aucun risque réel.

---

### 244c057 — Remove wrong subproperty link from sales_product_number to sales_product_name

**Verdict : Justifié**

**Ce que fait le commit.** Supprime une seule ligne : `rdfs:subPropertyOf ecsel-dr-PROD:sales_product_name` dans la définition de `ecsel-dr-PROD:sales_product_number`. Domaine (`Sales_Product`), range (`xsd:string`), commentaire et label conservés.

**Preuves.**
- L'axiome était sémantiquement faux : il entraîne que toute assertion `x sales_product_number "123"` implique `x sales_product_name "123"` — chaque numéro serait aussi un nom. Les commentaires des deux propriétés les opposent explicitement : `sales_product_name` « **might not be sufficient for unique identification** » vs `sales_product_number` « a **unique identifier** of a Sales Product ». Un identifiant unique ne peut pas être une spécialisation d'un nom non unique.
- Aucune hiérarchie « identifiant » voulue dans ce module : `finished_product_number` et `orderable_part_number` (même module) n'ont aucun parent ; `product_number`, `customer_number`, `customer_part_number` (autres modules) pointent vers `owl:topDataProperty` (parent trivial). `sales_product_number` était l'anomalie isolée.
- Le seul vrai pattern « identifier » (module OOSMP : `identifier` → `identifier_product` → …) est fait d'`owl:AnnotationProperty` d'un autre module — inutilisable comme parent d'une DatatypeProperty PROD sans refonte inter-modules. La suppression sèche est donc le bon remède, cohérent avec les propriétés sœurs.
- Origine : le lien remonte au tout premier commit public (`53d3141` : `salesProductNumber rdfs:subPropertyOf salesProductName`) et a survécu aux renommages — erreur historique, pas design.
- Pas d'effet collatéral : la seule autre utilisation de `sales_product_number` (restriction dans le domaine de `shipped_to`) n'est pas affectée ; retirer un axiome `subPropertyOf` ne fait que retirer des inférences (monotonie OWL). Syntaxe Turtle valide.

**Réserves/risques.** Théorique : une application aval s'appuyant sur l'inférence « numéro ⇒ nom » comme libellé de repli la perdrait — mais cette inférence était précisément le bug.

---

### 638ebaf — Reparent GDM Supply_Chain to its lobe instead of Supply_Contract

**Verdict : Justifié**

**Ce que fait le commit.** Une seule ligne (20489) : la classe `ecsel-dr-GDM:Supply_Chain` cesse d'être sous-classe de `ecsel-dr-DF:Supply_Contract` et redevient sous-classe directe de `dr:Supply_Chain_Lobe`. Ses trois restrictions OWL (cycle time commitment, delivery commitment, release plan) sont intégralement conservées.

**Preuves.**
- **Le fix restaure l'état historique — le lien vers Supply_Contract était une régression** : `git log -S` montre que le lien a été introduit par le commit amont `6b2dc7a` (« Definitions improved in Planning and Supply Chain Lobes », Infineon, juillet 2025) ; avant ce commit, la classe était déjà `rdfs:subClassOf dr:Supply_Chain_Lobe`. Le commit remet exactement le parent d'origine.
- Indice fort de confusion dans `6b2dc7a` : ce même commit a ajouté le **même** `skos:altLabel "_DR sc"` à la fois sur `DF:Supply_Chain` et `DF:Supply_Contract` — les deux concepts partagent l'abréviation « sc », ce qui explique la substitution accidentelle lors de cette édition de masse (390 insertions/226 suppressions).
- Sémantiquement absurde et logiquement incohérent : `Supply_Chain` = « the network of organizations, resources, activities, and technologies… » ; `Supply_Contract` = « a formal agreement… legally binding relationship ». Un réseau n'est pas un accord juridique. Pire : `DF:Supply_Chain` déclare `owl:equivalentClass ecsel-dr-GDM:Supply_Chain, ecsel-dr-SO:Supply_Chain` — avant le fix, un raisonneur inférait que **toute** Supply Chain est un Supply Contract, tout en gardant `DF:Supply_Chain` sous le lobe : hiérarchie contradictoire avec elle-même.
- Conforme au pattern des classes sœurs : toutes les classes GDM sont rattachées directement à un lobe (`Target_Costs` → `Semiconductor_Production_Lobe`, `Target_Revenue` → `Product_Lobe`, `Time_Constraint` → `Process_Lobe`, …), et `dr:Supply_Chain_Lobe` est précisément le lobe décrivant la supply chain.

**Réserves/risques.** Pratiquement aucun. Le scénario « lien intentionnel » est réfuté par la nature du commit amont (lot d'amélioration de définitions, pas de refonte hiérarchique), l'altLabel dupliqué, et l'incohérence logique du résultat. `Supply_Contract` reste défini et utilisé ailleurs (range d'une propriété) — rien n'est cassé.

---

### 5461712 — Replace non-standard rdfs:description with rdfs:comment in Quality module

**Verdict : Justifié**

**Ce que fait le commit.** 160 insertions/162 suppressions dans `DigitalReference.ttl` : remplace les 160 usages de `rdfs:description` par `rdfs:comment` — tous dans le module Quality — et supprime la déclaration ad hoc `rdfs:description rdf:type owl:AnnotationProperty .` (plus sa ligne de commentaire), devenue inutile.

**Preuves.**
- `rdfs:description` n'existe pas dans RDFS : le vocabulaire standard ne définit que `label`, `comment`, `seeAlso`, `isDefinedBy`, `domain`, `range`, `subClassOf`, `subPropertyOf`, `member` (+ classes). Le préfixe pointait bien vers le namespace RDFS (`@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>`, inchangé) : c'était une invention de terme dans un namespace W3C, masquée par une déclaration d'AnnotationProperty.
- Littéraux préservés à l'identique : extraction des 160 lignes supprimées et des 160 ajoutées, normalisation du prédicat, tri, comparaison — **diff vide**.
- `rdfs:comment` est le bon remplacement au vu des conventions : 1465 usages de `rdfs:comment` pour décrire classes/propriétés (contre 232 `skos:definition` et 2 `dc:description`, réservés aux métadonnées de l'ontologie) ; l'ontologie annote elle-même `rdfs:comment` comme « The definition or description of a concept ».
- Fix complet : 0 occurrence de `rdfs:description` après, dans tout le dépôt (fichier principal + `dependencies/*.ttl`) ; vérifié aussi par parsing (16 341 triplets, 0 avec ce prédicat).
- Pas d'effet de bord : aucun sujet ne se retrouve avec un `rdfs:comment` dupliqué ; comptes cohérents (162 suppressions = 160 usages + déclaration + ligne de commentaire).

**Réserves/risques.** Aucun risque réel. `skos:definition` aurait été défendable aussi, mais `rdfs:comment` est la convention très dominante du fichier. Un outil externe requêtant spécifiquement `rdfs:description` perdrait ces annotations — mais s'appuyer sur un terme inexistant était précisément le bug.

---

### ab3a462 — Make Available_Capacity a sibling of Required_Capacity under Capacity

**Verdict : Justifié**

**Ce que fait le commit.** Une seule ligne (22161) : `ecsel-dr-Planning:Available_Capacity` cesse d'être `rdfs:subClassOf Required_Capacity` pour devenir `rdfs:subClassOf dr:Capacity` — sœur de `Required_Capacity`.

**Preuves.**
- L'ancien rattachement était sémantiquement faux : les définitions décrivent des concepts opposés (offre vs demande). `Available_Capacity` : « the ability of a resource within a period of time to perform activities… obtained from the nominal capacity by subtracting the anticipated and unavoidable loss in productivity » (capacité **disponible**, côté ressources). `Required_Capacity` : « The amount of production capability… that is **needed**… to fulfill the anticipated demand » (capacité **requise**, côté demande). L'axiome `Available ⊑ Required` impliquait que toute capacité disponible EST une capacité requise — et faisait hériter aux capacités disponibles les domaines de propriétés propres à `Required_Capacity` (`consumed_qantity`, `offset_periods`).
- Le nouveau parent est cohérent : `dr:Capacity` (« the maximum number of products… a machine or a group of machines can produce ») généralise correctement les deux notions ; `Required_Capacity` était **déjà** sous `dr:Capacity` avant le commit — le fix rend la hiérarchie symétrique, comme annoncé.
- Origine : erreur remontant à l'import initial du module Planning (`391622b`/`ca2f66d`), sans justification dans l'historique.
- Aucune casse collatérale : parsing OK (16 341 triplets) ; les dépendances de `Available_Capacity` (range de `has_capacity`, domaines de `maximum_capacity`/`minimum_capacity`, 15 individus `AvailableCapN`) portent directement sur la classe et pas sur l'ancienne subsomption.

**Réserves/risques.** Hors périmètre, préexistants : `Aggregated_Capacity` reste sous `Planning_Lobe` (rattachement à `Capacity` discutable vu sa définition ACG — abstention défendable) ; `Capacity_Bottleneck ⊑ Capacity` (définition décrivant une machine) et `Bottleneck_Resource ⊑ Resource_Capacity` (une ressource sous une capacité) sont des maladresses distinctes. Rien dans le dépôt ne dépendait de l'ancienne inférence.

---

### dfdcf49 — Reparent SSO_Stocks under Stocks instead of Operational_Demand

**Verdict : Justifié** (avec deux réserves mineures)

**Ce que fait le commit.** Une seule ligne : l'axiome `rdfs:subClassOf` de `ecsel-dr-Planning-SCP:SSO_Stocks` passe de `Operational_Demand` à `Stocks` (même module). Rien d'autre.

**Preuves.**
- La définition (préexistante, inchangée) décrit sans ambiguïté un stock, pas une demande : « SSO Stocks refers to SSO stock profiles applied exclusively at the finished goods level… encompasses three subtypes: Retained Stock… Min Stock, representing the minimum inventory level desired on hand… and Max Stock, representing the maximum inventory level permitted… ».
- L'ancien parent était incompatible : `Operational_Demand` = « a supply chain or production request… coming from company intern business division ». Un profil de stock n'est pas une « request » ; l'axiome impliquait que tout Min/Max/Safety Stock *est* une demande opérationnelle — erreur de catégorie.
- Le nouveau parent correspond : `Stocks` = « A supply of something for use or sale », dont les autres sous-classes sont toutes de nature inventaire (`DC`, `Die_Bank`, `WIP`).
- Cohérence de la famille : `SSO_Stocks` est la seule classe `SSO_*` ; ses cinq sous-classes (`Min_Stock`, `Max_Stock`, `Safety_Stock`, `Retained_Stock`, `Ramp_Up_Stock`) sont toutes des niveaux/tampons d'inventaire ; la définition de `Retained_Stock` confirme (« the broader SSO Stocks family, which governs strategic stock profiles at the finished goods level »).
- Hypothèse charitable testée et écartée : dans les APS, les cibles de stock *génèrent* de la demande lors du supply-demand matching — mais même dans cette lecture, la relation correcte serait une propriété (« génère une demande »), pas une subsomption is-a. Aucune propriété (domain/range) ne référence SSO_Stocks : rien n'est cassé.

**Réserves/risques.** (1) Perte du rattachement transitif au lobe Planning : avant, héritage de `dr:Planning_Lobe` via `Operational_Demand` ; après, héritage de `ssn:Stimulus` via `Stocks`. Une visualisation groupant par lobe perd la famille — mais c'était déjà le cas des pairs `DC`, `Die_Bank`, `WIP` : le commit rend la famille cohérente avec ses pairs plutôt qu'il n'introduit l'anomalie. (2) Nuance résiduelle : SSO_Stocks désigne des *profils/cibles* de stock plus que du stock physique ; « Stocks » n'est pas un parent parfait, mais de loin le meilleur disponible dans le module (la hiérarchie y est déjà lâche : `DC` et `Die_Bank` sont des *lieux*).

---

### 1e1c4dc — Reparent EDI_Forecast under Forecast instead of Order

**Verdict : Justifié**

**Ce que fait le commit.** Une seule ligne : `ecsel-dr-Planning-SCP:EDI_Forecast` cesse d'être `rdfs:subClassOf dr:Order` pour devenir `rdfs:subClassOf ecsel-dr-Planning-SCP:Forecast`. Le rattachement à `Order` datait de l'ontologie d'origine (défaut historique amont, présent dès `aa1598e`).

**Preuves.**
- L'annotation de la classe parle de forecast, pas de commande : « The EDI Forecast Universe is a Data Mart that was started in 2010 (?) to support **Forecast Accuracy** analysis ».
- La définition de `dr:Order` est incompatible : « a confirmation/receipt of a customer transaction… Each order position corresponds to an accepted Offer ». Un forecast est par nature non engageant ; `Forecast` = « an **unconstrained prospect** about the customer future demand » — le bon concept.
- L'ontologie oppose elle-même « orders » et « EDI forecast » à trois endroits : `Marketing_Demand` (« orders or EDI forecast »), `Operational_Demand` (idem), `Customer_Logistics_Management_Representative` (« taking care of **forecast**… typical for that is the EDI FORECAST »).
- Cohérence avec les sœurs : les autres forecasts du module (`AP_FCST`, `HP_Forecast`, `NP_Forecast`, `OP_Forecast`) sont tous sous `Forecast` ; les vraies sous-classes de `dr:Order` dans le module sont `Buffer_Stock_Order`, `Consignment_Order`, `Standard_Order` — des commandes réelles.
- La nuance EDI/EDIFACT est tranchée par l'ontologie elle-même : `Standard_Order` est défini « **EDI or manually entered**, can be shipped » — les commandes transmises par EDI sont déjà modélisées ; EDI est un mode de transmission, `EDI_Forecast` désigne le signal prévisionnel (type DELFOR), pas la commande (type ORDERS).
- Nouveau parent dans le bon module, même lobe (Forecast → Operational_Demand → Planning_Lobe) — plus local qu'avant. Aucun effet de bord : rien d'autre ne référence `EDI_Forecast`.

**Réserves/risques.** (1) Purement ontologique : le commentaire décrit littéralement un **Data Mart** (artefact informationnel), donc ni `Order` ni `Forecast` n'est un parent parfait — la classe confond signal et système qui le stocke ; entre les deux options, `Forecast` est sans ambiguïté la bonne. (2) Nuance métier écartée sur preuves internes : la « firm zone » quasi contractuelle d'un DELFOR ne change pas le traitement que l'ontologie fait de l'EDI Forecast comme forecast distinct des orders.

---

### 1f7af93 — Rewrite four copy-paste definitions to match their actual concepts

**Verdict : Justifié**

**Ce que fait le commit.** Un seul fichier, 4 lignes modifiées :

1. **`ecsel-dr-AT:Actuator_Device`** (lobe AT, sous-classe de `Wired_Communication_Device`) — avant : « converts control signals into physical actions which alter power flow… **within a power system** » ; après : définition générique d'actionneur. Le cadrage « power system » était du boilerplate plaqué depuis un lot orienté lobe Power.
2. **`ecsel-dr-Planning:Edge`** — avant : texte marketing sur l'**edge computing** en supply chain (« process data closer to where it is generated… reduce latency »), sans rapport avec la classe ; après : arête orientée entre deux sommets (DECISION-MAKING UNITS) portant instructions et réactions.
3. **`ecsel-dr-Planning:Vertex`** — avant : description de **Vertex Inc.**, l'éditeur de logiciels de taxes (« calculate, manage, and report indirect taxes… ») — collision de nom flagrante ; après : sommet = DECISION-MAKING UNIT d'une situation de planification, avec niveau et arêtes orientées.
4. **`ecsel-dr-Power-PWR:Blocking_Capability`** (lobe Power) — avant : « blocage » au sens supply chain (« stopping production, rejecting shipments, halting transactions ») ; après : capacité d'un composant électrique à empêcher la conduction du courant en état bloqué/inverse — le concept standard des semi-conducteurs de puissance.

**Preuves.**
- Origine des mauvais textes (deux passes de définitions en masse, visiblement générées par LLM) : `git log -S` — Actuator_Device et Blocking_Capability viennent de `203332c` (« New definitions added… », Infineon, mars 2026), lot où plusieurs classes AT reçoivent un cadrage « power » injustifié, et où `Blocking_Voltage` reçoit une définition électrique **correcte** tandis que sa voisine `Blocking_Capability` reçoit une définition supply chain — preuve du dérapage. Edge/Vertex viennent de `6b2dc7a` ; avant, ces classes n'avaient **aucun** commentaire ; les ~40 autres définitions du lot collent à leurs concepts — Edge et Vertex étaient les deux ratés par collision de nom.
- Les nouvelles définitions sont ancrées, pas inventées : le lobe Planning modélise déjà exactement cela (cadre de Schneeweiss 2003) — « We refer to the elements of the set as vertices » (l. 6413), « If a vertex provides instruction or a reaction to another vertex than the two vertices are connected by a directed edge » (`has_connection`), « Each vertex has a level… » (`level`), `has_DMUa`/`has_DMUb` vers `Decision_Making_Unit`. Les nouvelles définitions sont des assemblages quasi verbatim de ces commentaires préexistants. Celle de `Blocking_Capability` reprend mot pour mot la formulation de sa classe sœur `Blocking_Voltage` (« prevents or substantially inhibits current conduction… ») ; celle d'`Actuator_Device` est la définition classique d'un actionneur, cohérente avec sa sous-classe `Tooling_Machine`.
- Nuance sur le terme « copy-paste » : aucun des quatre textes n'était un doublon *interne* — il s'agit de texte collé depuis des sources externes décrivant le mauvais homonyme. La substance du diagnostic reste exacte.

**Réserves/risques.** (1) « Copy-paste » légèrement approximatif dans le message. (2) Nettoyage incomplet du lot `203332c` : `Bridge`, `Hub`, `Proxy`, `Industry_PC`, `Microcontroller` gardent un cadrage « power » injustifié (cf. rectification n° 6) ; `Real_Estate` dans le Power_Lobe et la lecture supply chain de `Hierarchical_Situation` sont aussi discutables — le commit ne prétendait corriger que quatre cas. (3) Bug préexistant non touché : le domaine de la propriété `level` (`Edge` + `Planning_Situation`) contredit son propre commentaire (ce sont les vertices qui ont un niveau).

---

### aec4dc0 — Remove four unused phantom namespace prefixes

**Verdict : Justifié**

**Ce que fait le commit.** Supprime 4 lignes `@prefix` de l'en-tête de `DigitalReference.ttl` (4 suppressions, 0 ajout). Ces préfixes déclaraient des variantes tronquées des vrais namespaces de modules :

| Préfixe supprimé | Namespace « fantôme » | Namespace réel du module |
|---|---|---|
| `ecsel-dr-AH:` | `…/ecsel-dr-AH#` | `ecsel-dr-Cloud-AH#` (626 occ.) |
| `ecsel-dr-ORG:` | `…/ecsel-dr-ORG#` | `ecsel-dr-Organization-ORG#` (170 occ.) |
| `ecsel-dr-PWR:` | `…/ecsel-dr-PWR#` | `ecsel-dr-Power-PWR#` (396 occ.) |
| `ecsel-dr-SCP:` | `…/ecsel-dr-SCP#` | `ecsel-dr-Planning-SCP#` (242 occ.) |

**Preuves.**
- Aucune utilisation en CURIE : à l'état avant, chaque préfixe n'a que 2 hits dans tout le dépôt — sa déclaration `@prefix` et sa recopie documentaire dans le README. Zéro CURIE dans le corps du fichier.
- Namespaces quasi inexistants dans les données : comptage exhaustif — `ecsel-dr-AH#` = 1, `ecsel-dr-ORG#` = 1, `ecsel-dr-SCP#` = 1 (uniquement la ligne `@prefix` elle-même). D'où « phantom ».
- Le seul cas non trivial — PWR — est sans risque : une seule entité réelle existe dans `ecsel-dr-PWR#` (`Triode/Constant_Resistance_Region`, ligne 22128), mais écrite **en IRI complet entre chevrons**, jamais en CURIE (nom local avec `/`, inabréviable) ; la suppression du préfixe ne la touche pas.
- Vérification mécanique : les deux versions parsent, **16 341 triples chacune, graphes isomorphes** (`rdflib.compare`). Aucun triple modifié — seulement la table des préfixes.
- Cohérence : le commit suivant `56501c7` déclare les vrais préfixes — aec4dc0 est la première moitié d'un nettoyage en deux temps.

**Réserves/risques.** Documentaire seulement : le README liste toujours les 4 namespaces fantômes (cf. rectification n° 3). L'IRI isolée `ecsel-dr-PWR#Triode/Constant_Resistance_Region` reste une anomalie de contenu probable (cf. rectification n° 7) — non aggravée par ce commit.

---

### 56501c7 — Declare real module namespaces as prefixes and use CURIEs

**Verdict : Justifié**

**Ce que fait le commit.** +1066/−1060 lignes (soit +6 nettes) dans `DigitalReference.ttl` : déclare 6 nouveaux préfixes pour des namespaces réellement utilisés (`ecsel-dr-Cloud-AH`, `ecsel-dr-Power-PWR`, `ecsel-dr-Planning-SCP`, `ecsel-dr-Organization-ORG`, `ecsel-dr-Planning-DF`, `ecsel-dr-Organization`) puis remplace toutes les occurrences des IRIs complets correspondants par des CURIEs, alignant ces 6 modules sur le style des ~18 autres.

**Preuves** (vérifiées sur les blobs exacts, hashes contrôlés par `git hash-object`) :
- Correspondance exacte préfixe ↔ namespace, octet pour octet (casse, `#` final) ; aucune variante de casse ni `/` vs `#` de ces namespaces dans le fichier (grep insensible à la casse : 0 divergence).
- Conversion complète et sans perte, comptages exacts :

| Préfixe | IRIs complets avant | CURIEs après | IRIs restants après |
|---|---|---|---|
| ecsel-dr-Cloud-AH | 454 | 454 | 1 (la déclaration `@prefix`) |
| ecsel-dr-Power-PWR | 272 | 272 | 1 |
| ecsel-dr-Planning-SCP | 161 | 161 | 1 |
| ecsel-dr-Organization-ORG | 119 | 119 | 1 |
| ecsel-dr-Planning-DF | 32 | 32 | 1 |
| ecsel-dr-Organization | 22 | 22 | 1 |

  L'ensemble des noms locaux en CURIE après = exactement l'ensemble des noms locaux des IRIs d'avant (différence ensembliste vide dans les deux sens). Le +6 net = les 6 déclarations `@prefix`.
- Preuve sémantique formelle : **16 341 triplets avant, 16 341 après, graphes strictement isomorphes** (`rdflib.compare.to_isomorphic`, y compris nœuds anonymes des `owl:unionOf`/restrictions). Changement purement syntaxique.
- Cas limites correctement gérés : les 441 noms locaux distincts convertis sont tous de la forme `[A-Za-z_][A-Za-z0-9_]*`. Les entités piégeuses du fichier — `Bill_Of_Material_(BOM)` (parenthèses), `3Phase_Topology`, `5G`, `2G_GPRS` (chiffre initial), `Triode/Constant_Resistance_Region` (slash) — appartiennent à d'autres namespaces, hors périmètre, et restent en IRIs complets, intactes. Aucun cas piégeux converti à tort.
- Pas de collision de préfixes : `ecsel-dr-Organization`, `ecsel-dr-Organization-ORG` et `ecsel-dr-ORG` (préexistant) sont trois namespaces distincts, chacun avec son préfixe ; le parsing Turtle les distingue sans ambiguïté (confirmé par l'isomorphisme).

**Réserves/risques.** Aucun sur le plan sémantique ou syntaxique (préfixes avec tirets internes conformes à la grammaire `PN_PREFIX` de Turtle/SPARQL). Les entités à noms locaux non convertibles restent volontairement en IRIs complets — comportement correct, pas un défaut.

---

*Document généré à partir des 21 rapports d'audit indépendants (agents en lecture seule, validation rdflib), juillet 2026. L'audit lui-même n'a rien modifié ; les rectifications complémentaires listées en tête de document ont été appliquées le 24 juillet 2026 (points 1–7), vérifiées par 3 agents indépendants supplémentaires puis validées par parsing rdflib (16 341 → 16 371 triples, delta +30 conforme). Rectifications commitées individuellement (un commit par famille) sur la branche `ontology-fixes`, ce document en dernier.*
