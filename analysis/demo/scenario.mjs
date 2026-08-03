/**
 * Scénario de la vidéo de démo.
 *
 * Chaque « beat » associe une phrase de narration (fr + en) à une action sur
 * la page. Le moteur (record.mjs) synthétise la voix, mesure sa durée, joue
 * l'action, et ne passe au beat suivant que lorsque les deux sont finis — la
 * vidéo se cale donc toujours sur la narration, jamais l'inverse.
 *
 * Pour modifier la démo : éditer ce fichier uniquement.
 */

export const VOICES = {
  fr: "fr-FR-DeniseNeural",
  en: "en-US-AriaNeural",
};

/** Classe du Digital Reference servant à la sélection, l'épinglage et le split. */
const DR_CLASS = "Semiconductor Product";
/** Classe de l'ontologie importée : c'est elle qui gagne un lien vers le DR. */
const IMPORTED_CLASS = "Rush Order";
/** Question posée deux fois au chatbot : sans, puis avec l'ontologie importée. */
const QUESTION = "How are transport CO2 emissions modelled, and which classes carry them?";

export const beats = [
  /* ----------------------------- Le graphe ----------------------------- */
  {
    id: "intro",
    fr: "Le Digital Reference est une ontologie de mille deux cent soixante-treize classes pour le semi-conducteur. Cet explorateur la rend navigable.",
    en: "The Digital Reference is a twelve-hundred-class ontology for the semiconductor industry. This explorer makes it navigable.",
    run: async (h) => h.orbit(5000),
  },
  {
    id: "lobes",
    fr: "Les classes sont colorées par lobe : quinze grands domaines, de la chaîne d'approvisionnement à la production.",
    en: "Classes are coloured by lobe — fifteen domains, from supply chain to production.",
    run: async (h) => h.orbit(4000),
  },
  {
    id: "select",
    fr: "On cherche une classe : la caméra s'y pose et le panneau de droite donne ses attributs et ses relations.",
    en: "Search a class: the camera flies to it, and the right-hand panel gives its attributes and relations.",
    run: async (h) => {
      await h.searchClass(DR_CLASS);
      await h.pause(2200);
    },
  },
  {
    id: "orbit-selection",
    fr: "À partir de là, toute la navigation tourne autour de la classe sélectionnée : un tour complet, sans jamais la perdre de vue.",
    en: "From there, navigation orbits around the selected class: a full turn around it, without ever losing sight of it.",
    run: async (h) => h.orbit(8000, 1),
  },

  /* ---------------------------- Le workspace ---------------------------- */
  {
    id: "ws-open",
    fr: "Le Workspace sert à raccrocher une ontologie externe au Digital Reference.",
    en: "The Workspace is where an external ontology gets attached to the Digital Reference.",
    run: async (h) => {
      await h.tab("Workspace");
      await h.pause(800);
    },
  },
  {
    id: "ws-import",
    fr: "On importe Factory Logistics : un petit modèle de logistique d'usine, treize classes.",
    en: "We import Factory Logistics — a small factory-logistics model, thirteen classes.",
    run: async (h) => {
      if (h.fast) await h.page.locator(".conv-item").first().click();
      else await h.importOntology();
      await h.pause(1200);
    },
  },
  {
    id: "ws-compare",
    fr: "Comparer au Digital Reference note chaque classe sur trois facettes : lexicale, structurelle et sémantique.",
    en: "Comparing to the Digital Reference scores every class on three facets: lexical, structural and semantic.",
    run: async (h) => {
      if (h.fast) await h.wsTab("Comparison");
      else await h.wsAction("Compare to DR", ".ws-table");
      await h.pause(1200);
    },
  },
  {
    id: "ws-compare-read",
    fr: "Chaque classe importée reçoit son meilleur candidat. Un score lexical fort mais un structurel faible trahit un faux ami.",
    en: "Each imported class gets its best candidate. Strong lexical but weak structural similarity is the signature of a false friend.",
    run: async (h) => h.scroll(".ws-scroll", 380, 3500),
  },
  {
    id: "ws-map-start",
    fr: "Mapper au Digital Reference fait vérifier ces candidats par un modèle de langage, qui tranche sur la relation exacte.",
    en: "Mapping to the Digital Reference sends those candidates to a language model, which settles the exact relation.",
    run: async (h) => {
      if (h.fast) await h.wsTab("Mapping");
      // lancé sans attendre : la phrase suivante se joue pendant l'alignement
      else
        h.ctx.mapping = h
          .wsAction("Map to DR", '.ws-tab:has-text("Mapping")', 300000)
          .catch((e) => console.warn(`!! alignement échoué : ${e.message}`));
      await h.pause(1500);
    },
  },
  {
    id: "ws-map-wait",
    fr: "Le Digital Reference n'est jamais modifié : le résultat est une ontologie liée à part, exportable en Turtle ou au format SSSOM.",
    en: "The Digital Reference is never modified. The result is a separate linked ontology, exportable as Turtle or SSSOM.",
    run: async (h) => {
      if (h.ctx.mapping) await h.ctx.mapping;
      await h.pause(1200);
    },
  },
  {
    id: "ws-map-read",
    fr: "Correspondances exactes, relations plus larges, et ce qui reste délibérément non lié : la machine à café n'a pas d'équivalent dans le Digital Reference.",
    en: "Exact matches, broader relations, and what stays deliberately unlinked — the coffee machine has no counterpart in the Digital Reference.",
    run: async (h) => h.scroll(".ws-scroll", 480, 4000),
  },

  /* ------------------- Retour au graphe : raw / linked ------------------- */
  {
    id: "graph-back",
    fr: "Retour au graphe. L'ontologie importée apparaît dans les calques : en la mettant en évidence, on voit son îlot au milieu du Digital Reference.",
    en: "Back to the graph. The imported ontology shows up in the layers panel; highlighting it reveals its island inside the Digital Reference.",
    run: async (h) => {
      await h.tab("Graph");
      await h.pause(2200);
      await h.overlay("raw", { focus: true });
      await h.orbit(3500);
    },
  },
  {
    id: "raw",
    fr: "En version brute, Rush Order ne connaît que sa propre ontologie : une seule relation, vers sa classe parente d'origine.",
    en: "In its raw version, Rush Order only knows its own ontology: a single relation, up to its original parent class.",
    run: async (h) => {
      await h.searchClass(IMPORTED_CLASS);
      // la caméra se colle au nœud choisi : sans recul, les voisins remplissent
      // l'écran de grosses taches translucides et le plan devient illisible
      await h.zoom(1500, 1400);
      await h.orbit(3000, 0.35);
    },
  },
  {
    id: "linked",
    fr: "En version liée, un axiome broadMatch la raccroche à Customer Order, une classe du Digital Reference. L'arête apparaît, étiquetée, dans le graphe.",
    en: "In its linked version, a broadMatch axiom ties it to Customer Order, a Digital Reference class. The edge shows up in the graph, labelled.",
    run: async (h) => {
      await h.overlay("linked");
      await h.pause(1200);
      await h.searchClass(IMPORTED_CLASS);
      await h.zoom(1500, 1400);
      await h.pause(800);
      await h.orbit(3500, 0.35);
    },
  },

  /* ------------------------- Épinglage et split ------------------------- */
  {
    id: "pin",
    fr: "En reculant sur le graphe entier, on peut saisir n'importe quel nœud et le tirer à l'écart : ses voisins suivent, retenus par leurs arêtes.",
    en: "Pulling back to the whole graph, you can grab any node and drag it clear: its neighbours follow, held by their edges.",
    run: async (h) => {
      await h.unfocus();
      await h.searchClass(DR_CLASS); // amène le nœud au centre de la vue
      // Recul modéré, mesuré : au-delà le graphe devient illisible et le nœud
      // trop petit pour être saisi. Et surtout aucune désélection ici : chaque
      // seconde écoulée laisse le nœud dériver du centre, et la prise échoue.
      await h.zoom(1400, 1600);
      // c'est la distance du glissement, plus que le recul, qui donne à voir
      // la séparation : le nœud part loin en étirant ses arêtes
      await h.pinNode({ dx: -640, dy: -380 });
    },
  },
  {
    id: "pin-hold",
    fr: "Maintenu immobile une seconde, il se fige sur place : il reste là pendant qu'on en fait le tour et que tout le reste continue de bouger.",
    en: "Held still for a second, it freezes in place: it stays put while we circle around it and everything else keeps drifting.",
    run: async (h) => h.orbit(8000, 1),
  },
  {
    id: "split",
    fr: "Le Split extrait un sous-ensemble : on part d'une classe, et tout ce qui reste allumé dans le graphe sera exporté.",
    en: "Split extracts a subset: you start from one class, and everything left lit in the graph gets exported.",
    run: async (h) => {
      await h.startSplit(); // re-sélectionne la classe, donc rapproche la caméra
      // la graine est mémorisée : on peut désélectionner, et c'est alors le
      // sous-ensemble lui-même qui reste allumé quand les options changent
      await h.deselect();
      await h.zoom(900, 1600); // on reprend un peu de champ, gardé jusqu'au seuil
      await h.pause(1000);
    },
  },
  {
    id: "split-expand",
    fr: "Les règles d'expansion décident jusqu'où il s'étend : la descente des sous-classes, la remontée du contexte, puis un ou deux sauts le long des propriétés. Le compteur suit chaque changement.",
    en: "The expansion rules decide how far it reaches: down through the subclasses, up for the parent context, then one or two hops along the object properties. The counter follows every change.",
    run: async (h) => h.splitOptions(),
  },
  {
    id: "split-export",
    fr: "Le sous-ensemble s'exporte alors en Turtle autonome, réimportable tel quel dans le Workspace.",
    en: "The subset then exports as standalone Turtle, ready to be re-imported into the Workspace.",
    run: async (h) => {
      await h.exportSplit();
      await h.pause(2200);
    },
  },
  {
    id: "threshold",
    fr: "Enfin, sur le graphe entier et sans rien de sélectionné, un seuil d'importance masque les feuilles et ne laisse que la charpente.",
    en: "Finally, on the whole graph with nothing selected, an importance threshold hides the leaves and leaves only the load-bearing structure.",
    run: async (h) => {
      await h.closeSplit();
      await h.deselect(); // rend leurs couleurs aux classes non voisines
      await h.slider(0.28, 2400);
      await h.pause(3500);
      await h.slider(0, 1200);
    },
  },

  /* ------------------------------ Le chat ------------------------------ */
  {
    id: "chat-open",
    fr: "Le chatbot, pour finir. Il répond à partir de l'ontologie, et montre son raisonnement étape par étape.",
    en: "The chatbot, to finish. It answers from the ontology itself, and shows its reasoning step by step.",
    run: async (h) => {
      await h.tab("ChatBot");
      await h.pause(1200);
    },
  },
  {
    id: "chat-q1",
    fr: "Première question, avec le Digital Reference seul dans le contexte.",
    en: "First question, with the Digital Reference alone in the context.",
    run: async (h) => {
      await h.setChatContext(false);
      await h.ask(QUESTION);
    },
  },
  {
    id: "chat-a1",
    fr: "La réponse ne cite que des classes du Digital Reference : l'ontologie importée n'existe pas pour elle.",
    en: "The answer only cites Digital Reference classes — the imported ontology does not exist for it.",
    run: async (h) => h.scroll(".chat-scroll", 380, 4000),
  },
  {
    id: "chat-q2",
    fr: "On ajoute maintenant Factory Logistics au contexte, et on repose exactement la même question.",
    en: "Now we add Factory Logistics to the context and ask exactly the same question again.",
    run: async (h) => {
      await h.newChat();
      await h.setChatContext(true);
      await h.ask(QUESTION);
    },
  },
  {
    id: "chat-a2",
    fr: "Cette fois les classes importées entrent dans la réponse, rattachées au Digital Reference par les liens calculés tout à l'heure.",
    en: "This time the imported classes enter the answer, tied to the Digital Reference through the links computed earlier.",
    run: async (h) => h.scroll(".chat-scroll", 400, 4500),
  },
  {
    id: "outro",
    fr: "Une ontologie externe importée, alignée, visualisée et interrogée, sans jamais toucher au Digital Reference.",
    en: "An external ontology imported, aligned, visualised and queried — without ever touching the Digital Reference.",
    run: async (h) => h.pause(1500),
  },
  {
    id: "feedback",
    fr: "Et surtout : vos retours sont les bienvenus. Une idée, une question, quelque chose à changer — n'hésitez pas.",
    en: "And above all: your feedback is welcome. An idea, a question, anything you would change — please don't hesitate.",
    run: async (h) => {
      await h.endCard("Feedback welcome", [
        "Ideas, questions, anything you would change —<br>please don't hesitate to get in touch.",
        "<span style=\"font-size:26px;color:#70757a\">This demo is generated from a script: it can be reshot in minutes.</span>",
      ]);
      await h.caption("", null); // la carte parle d'elle-même, pas de sous-titre
      await h.pause(4000);
    },
  },
];

export const meta = { drClass: DR_CLASS, importedClass: IMPORTED_CLASS, question: QUESTION };
