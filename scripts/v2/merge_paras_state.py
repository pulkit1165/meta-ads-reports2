#!/usr/bin/env python3
"""Union-merge the freshly built paras_videos.json with the last good copy
(paras-state, available as FETCH_HEAD after the restore step). An account whose
async insights pull failed this hour keeps its videos from the previous good
run instead of vanishing from the page. New data always wins per video_id."""
import json
import subprocess
import sys
from collections import defaultdict

F = 'antariksh/paras_videos.json'
try:
    old = json.loads(subprocess.run(['git', 'show', 'FETCH_HEAD:' + F],
                                    capture_output=True, text=True, check=True).stdout)
    new = json.load(open(F))
except Exception as e:
    print('merge skipped:', e)
    sys.exit(0)

have = {v['video_id'] for v in new['videos']}
carried = [v for v in old['videos'] if v['video_id'] not in have]
if not carried:
    print('nothing to carry — new dataset is a superset')
    sys.exit(0)

new['videos'] += carried
new['videos'].sort(key=lambda v: -v.get('spend', 0))
new['totals']['videos'] = len(new['videos'])
cats = defaultdict(lambda: {'videos': 0, 'tries': 0, 'spend': 0.0, 'revenue': 0.0})
for v in new['videos']:
    c = cats[v['category']]
    c['videos'] += 1
    c['tries'] += v.get('tries', 0)
    c['spend'] += v.get('spend', 0)
    c['revenue'] += v.get('revenue', 0)
for c in cats.values():
    c['roas'] = round(c['revenue'] / c['spend'], 2) if c['spend'] else 0.0
new['categories'] = cats
json.dump(new, open(F, 'w'), indent=1, default=str)
print(f'carried {len(carried)} videos from last good run -> {len(new["videos"])} total')
