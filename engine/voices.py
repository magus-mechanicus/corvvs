"""
Kokoro's voice roster, served by GET /voices.

Lives on the engine rather than in the npm client so that adding a voice is an engine
change alone — no client release, no version skew between the two.

`grade` is the model author's own quality rating for each voice (A best, F worst) and is
worth surfacing in any UI: the roster is large but only a handful of voices are actually
good. `af_heart` (grade A) is the default for that reason.

Copied from kokoro-js 1.2.1's `dist/kokoro.cjs`, where this data is a private constant
rather than a runtime export — reaching it programmatically would mean loading a whole
model just to list names.
"""

VOICES = [
    {'id': 'af_heart',    'name': 'Heart',    'gender': 'female', 'language': 'en-US', 'grade': 'A'},
    {'id': 'af_bella',    'name': 'Bella',    'gender': 'female', 'language': 'en-US', 'grade': 'A-'},
    {'id': 'af_nicole',   'name': 'Nicole',   'gender': 'female', 'language': 'en-US', 'grade': 'B-'},
    {'id': 'af_aoede',    'name': 'Aoede',    'gender': 'female', 'language': 'en-US', 'grade': 'C+'},
    {'id': 'af_kore',     'name': 'Kore',     'gender': 'female', 'language': 'en-US', 'grade': 'C+'},
    {'id': 'af_sarah',    'name': 'Sarah',    'gender': 'female', 'language': 'en-US', 'grade': 'C+'},
    {'id': 'af_alloy',    'name': 'Alloy',    'gender': 'female', 'language': 'en-US', 'grade': 'C'},
    {'id': 'af_nova',     'name': 'Nova',     'gender': 'female', 'language': 'en-US', 'grade': 'C'},
    {'id': 'af_sky',      'name': 'Sky',      'gender': 'female', 'language': 'en-US', 'grade': 'C-'},
    {'id': 'af_jessica',  'name': 'Jessica',  'gender': 'female', 'language': 'en-US', 'grade': 'D'},
    {'id': 'af_river',    'name': 'River',    'gender': 'female', 'language': 'en-US', 'grade': 'D'},
    {'id': 'am_fenrir',   'name': 'Fenrir',   'gender': 'male',   'language': 'en-US', 'grade': 'C+'},
    {'id': 'am_michael',  'name': 'Michael',  'gender': 'male',   'language': 'en-US', 'grade': 'C+'},
    {'id': 'am_puck',     'name': 'Puck',     'gender': 'male',   'language': 'en-US', 'grade': 'C+'},
    {'id': 'am_echo',     'name': 'Echo',     'gender': 'male',   'language': 'en-US', 'grade': 'D'},
    {'id': 'am_eric',     'name': 'Eric',     'gender': 'male',   'language': 'en-US', 'grade': 'D'},
    {'id': 'am_liam',     'name': 'Liam',     'gender': 'male',   'language': 'en-US', 'grade': 'D'},
    {'id': 'am_onyx',     'name': 'Onyx',     'gender': 'male',   'language': 'en-US', 'grade': 'D'},
    {'id': 'am_santa',    'name': 'Santa',    'gender': 'male',   'language': 'en-US', 'grade': 'D-'},
    {'id': 'am_adam',     'name': 'Adam',     'gender': 'male',   'language': 'en-US', 'grade': 'F+'},
    {'id': 'bf_emma',     'name': 'Emma',     'gender': 'female', 'language': 'en-GB', 'grade': 'B-'},
    {'id': 'bf_isabella', 'name': 'Isabella', 'gender': 'female', 'language': 'en-GB', 'grade': 'C'},
    {'id': 'bf_alice',    'name': 'Alice',    'gender': 'female', 'language': 'en-GB', 'grade': 'D'},
    {'id': 'bf_lily',     'name': 'Lily',     'gender': 'female', 'language': 'en-GB', 'grade': 'D'},
    {'id': 'bm_george',   'name': 'George',   'gender': 'male',   'language': 'en-GB', 'grade': 'C'},
    {'id': 'bm_fable',    'name': 'Fable',    'gender': 'male',   'language': 'en-GB', 'grade': 'C'},
    {'id': 'bm_lewis',    'name': 'Lewis',    'gender': 'male',   'language': 'en-GB', 'grade': 'D+'},
    {'id': 'bm_daniel',   'name': 'Daniel',   'gender': 'male',   'language': 'en-GB', 'grade': 'D'},
]

VOICE_IDS = frozenset(v['id'] for v in VOICES)
