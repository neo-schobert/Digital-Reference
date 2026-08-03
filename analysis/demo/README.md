# Vidéo de démo automatisée

Une IA joue la démo à votre place : elle pilote l'application dans un vrai
navigateur, la filme, et pose la voix off par-dessus. Personne ne touche à la
souris, et la vidéo se refait à l'identique après chaque changement d'interface.

```bash
../start.sh        # l'app doit tourner
./record.sh        # → out/dr-demo-en.mp4 (+ .srt)
```

| Option | Effet |
|---|---|
| `--lang fr` | narration française (`out/dr-demo-fr.mp4`) |
| `--fast` | réutilise l'alignement déjà calculé : pas d'appel LLM, ~2 min de moins |
| `--silent` | pas de voix off, sous-titres incrustés seulement |
| `--out fichier.mp4` | chemin de sortie |

Comptez environ six minutes pour un tournage complet (dont ~1 min d'alignement
LLM et 2 × 15 s de réponse du chatbot), pour une vidéo d'environ quatre minutes et demie
en 1920 × 1080.

## Ce que montre la démo

Le graphe 3D et ses lobes → la recherche d'une classe → l'import de
`exemple/factory-logistics.ttl` dans le Workspace → la comparaison
multi-facettes → l'alignement vérifié par LLM → le retour au graphe en versions
`raw` puis `linked` → l'épinglage d'un nœud → le Split et son export Turtle →
le seuil d'importance → et enfin la même question posée deux fois au chatbot,
sans puis avec l'ontologie importée dans le contexte.

## Comment ça marche

`record.mjs` enchaîne trois étapes :

1. **Voix** — `edge-tts` synthétise chaque phrase et sa durée est mesurée
   *avant* le tournage. C'est ce qui permet aux actions de se caler sur la
   narration plutôt que l'inverse.
2. **Tournage** — Playwright ouvre Chromium en 1920 × 1080 et enregistre la
   vidéo lui-même (aucune capture d'écran système, pas besoin de session
   graphique). Chaque beat note son instant de départ réel, donc une action
   plus longue que prévu ne décale rien.
3. **Montage** — ffmpeg place chaque phrase à l'instant mesuré et encode en
   H.264/AAC, avec un fichier `.srt` à côté.

Le scénario vit dans **`scenario.mjs`** : une liste de beats
`{ id, fr, en, run }`. Pour changer le texte, l'ordre ou une interaction, c'est
le seul fichier à toucher.

## Dépendances

`record.sh` installe ce qui manque, sans droits root : Playwright et son
Chromium (dans `~/.cache/ms-playwright`), `edge-tts` (pip `--user`) et un
ffmpeg statique dans `~/.local/bin` — celui fourni par Playwright ne sait pas
encoder l'audio. La voix off appelle l'endpoint public de synthèse d'Edge : il
faut donc un accès réseau, mais aucun compte ni aucune clé.

## Point d'attention

Le tournage complet **importe et aligne `factory-logistics.ttl` en direct**. Si
une ontologie du même nom est déjà présente dans le Workspace, elle est
supprimée d'abord pour éviter les doublons — `.data/` est alors sauvegardé dans
`out/backup-data/`. Utiliser `--fast` pour ne rien supprimer et rejouer sur
l'alignement existant. Les conversations créées pendant le tournage sont
effacées de l'historique à la fin.
