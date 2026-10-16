"""Render measured pilot data only; no camera images or credentials are used."""
import json
from datetime import datetime
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

root = Path(__file__).resolve().parents[1]
data = json.loads((root / 'pilot/results/2026-10-13-twelve-minute-pilot.json').read_text())
ts = lambda value: datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
origin = ts(data['requestedStart'])
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'svg.fonttype': 'none'})
fig, (ax, drift) = plt.subplots(2, 1, figsize=(11, 7), gridspec_kw={'height_ratios': [2.2, 1]})
fig.patch.set_facecolor('#f8fafb')
fig.suptitle('FARBER  /  RING HISTORICAL PILOT', x=.07, y=.98, ha='left', fontsize=18, fontweight='bold', color='#102d36')
fig.text(.07, .92, 'Camera 1 · 13 October 2026 · actual footage exported after 24/7 enablement', color='#465b64')
labels=[]
for i, sample in enumerate(data['samples']):
    y=3-i
    r0=(ts(sample['requestedStart'])-origin)/60
    r1=(ts(sample['requestedEnd'])-origin)/60
    a0=(ts(sample['actualStart'])-origin)/60
    a1=(ts(sample['actualEnd'])-origin)/60
    ax.barh(y, r1-r0, left=r0, height=.55, facecolor='none', edgecolor='#344e5b', linewidth=1.2, zorder=3)
    ax.barh(y, a1-a0, left=a0, height=.34, color='#218768', zorder=2)
    labels.append(f"Clip {i+1}  ·  {sample['durationSeconds']:.3f} s")
ax.set_yticks([3,2,1,0], labels)
ax.set_xticks([0,1,2,7,12], ['14:08','14:09','14:10','14:15','14:20'])
ax.set_xlim(-.02,12.1)
ax.set_xlabel('Requested / actual intervals, EDT')
ax.legend(handles=[Patch(facecolor='none',edgecolor='#344e5b',label='Requested interval'),Patch(facecolor='#218768',label='Verified delivered interval')], loc='upper center', bbox_to_anchor=(.5,1.22), frameon=False,ncol=2)
ax.grid(axis='x',color='#dce4e6',zorder=0)
for t, amount in zip([1,2,7], data['boundaryOverlapMs']):
    ax.axvline(t, color='#b07819', linestyle=':', linewidth=1)
    ax.text(t+.07, -.27 if t == 2 else -.62, f'{amount} ms overlap', fontsize=9, color='#805a17')
ax.set_ylim(-.85,3.6)
for spine in ax.spines.values(): spine.set_visible(False)
values=[s['startDeltaMs'] for s in data['samples']]
drift.barh(range(4), values, color='#ca624c', height=.6)
drift.set_yticks(range(4), ['Clip 1','Clip 2','Clip 3','Clip 4'])
drift.invert_yaxis(); drift.set_xlim(0,70)
drift.set_xlabel('Actual start later than request (milliseconds; not hidden or rounded away)')
for i, value in enumerate(values): drift.text(value+1,i,str(value),va='center')
drift.grid(axis='x',color='#e5ebed'); drift.set_axisbelow(True)
for spine in drift.spines.values(): spine.set_visible(False)
fig.text(.07,.045,'Measured union: 719,967 / 720,000 ms. Initial 33 ms uncovered; no measured internal gap.\nLocal original-byte preservation only. This chart does not establish native authenticity, retention or OCM compliance.',fontsize=9,color='#465b64')
fig.subplots_adjust(left=.24,right=.96,top=.82,bottom=.16,hspace=.8)
fig.savefig(root/'docs/security/pilot-coverage.svg',facecolor=fig.get_facecolor())
svg=root/'docs/security/pilot-coverage.svg'
svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
private=root/'.pilot/review';private.mkdir(parents=True,exist_ok=True)
fig.savefig(private/'pilot-coverage.png',dpi=140,facecolor=fig.get_facecolor())
print('Coverage figure rendered from actual measured results.')
