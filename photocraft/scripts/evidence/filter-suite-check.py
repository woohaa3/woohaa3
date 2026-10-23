"""滤镜域证据套件的判定层：把 filter-suite.mjs 的输出压成 PASS/FAIL。

前置与 `filter-suite.mjs` 相同（先 `pnpm run wasm`，再打包 `.local/catalogue-bundle.mjs`）。
运行（在 photocraft/ 下）：`python3 scripts/evidence/filter-suite-check.py`
任一项失败时以非零码退出，便于直接挂进 CI 或人工复核。
"""
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
suite = os.path.join(here, "filter-suite.mjs")
raw = subprocess.run(["node", suite], capture_output=True, text=True).stdout
if "{" not in raw:
    print(raw.strip() or "filter-suite.mjs 没有输出", file=sys.stderr)
    sys.exit(2)
d = json.loads(raw[raw.index('{'):])
ok = True
def check(name, cond, detail=''):
    global ok
    print(('PASS' if cond else 'FAIL'), name, detail)
    if not cond: ok = False
c = d['consistency']
check('no declared-but-blocked', c['declaredButNotAllowed']==[] and c['declaredButGatedOff']==[])
check('no allowed-but-invisible', c['allowedButNotInCatalogue']==[])
check('counts 121/47/122', (c['catalogueFilters'],c['galleryFilters'],c['allowedFilterCommands'])==(121,47,122))
check('all commands start drafts', d['coverage']['refused']==[], f"started={d['coverage']['started']}")
check('all scalar controls accepted', d['controls']['failures']==[], f"checked={d['controls']['checked']}")
check('all gallery controls accepted', d['galleryControls']['failures']==[], f"checked={d['galleryControls']['checked']}/{d['galleryControls']['effects']}")
r=d['repeatLast']; check('repeat-last params/target', r['lastAvailable'] and r['sameParams'] and r['retargeted'])
l=d['lastFilterCommand']; check('lastFilter command', l['dispatched'] and l['changedPixels'] and l['historySteps']==1 and l['undoRestores'], f"shortcut={l['shortcut']}")
g=d['draftGuard']; check('draft gate holds', g['refused'] and g['draftUnchanged'] and g['stillDrafting'])
s=d['straighten']; check('straighten level/tilt/clear', (not s['level']['changed']) and s['tilted']['changed'] and (not s['cleared']['changed']) and not s['cleared']['hasStraighten'])
b={k:v for k,v in d['blurGallery'].items() if isinstance(v,dict)}
pc = d['perCommand']
check('every command changes pixels, one history step, undo restores',
      pc['failures'] == [] and pc['verified'] >= 100,
      f"verified={pc['verified']}, noops by design={len(pc['noops'])}")
# 空操作名单必须每条都有书面理由：否则「默认参数没效果」会被当成正当行为混过去。
check('each declared noop states its reason',
      all(pc['noopReasons'].get(name) for name in pc['noops']))
sr = d['seedReproducible']
check('fixed seed reproduces, different seed differs',
      sr['failures'] == [] and sr['checked'] >= 15,
      f"checked={sr['checked']}")
rt = d['roundtrip']
check('resource filters survive save/reopen, undo changes, redo restores',
      rt.get('failures') == [] and rt.get('checked', 0) >= 4,
      f"checked={rt.get('checked')}")
check('5 blur gallery commands', len(b)==5 and all(v.get('ok') and v.get('changed') for v in b.values()))
k=d['customKernel']; check('custom kernel identity/mean', (not k['identity']['changed']) and k['mean']['changed'] and k['identity']['kernelCount']==25)
p=d['displace']; check('displace by name + path refused', p['byName']['ok'] and p['localPathRefused'] and p['missingRefused'])
check('displace map sources carry per-document layers', p['sourcesCarryLayers'])
check('displace mapLayer gives a different result than flattening', p['layerChangesResult'] is True)
sc=d['shearCurve']; check('shear custom curve changes pixels and differs from amount',
      sc['customChangesPixels'] and sc['differsFromAmount'] and sc['straightIsNoop']
      and sc['unsortedRefused'] and sc['emptyRefused'])
gg=d['galleryGlow']; check('gallery glowColor changes pixels and different colours differ',
      gg['defaultChanges'] and gg['colourChangesPixels'] and gg['differentColoursDiffer'] and gg['badColourRefused'])
x=d['crossDomain']; check('cross-domain', x['selection']['candidateChanged'] and x['selection']['hasSelectionDuringDraft'] and x['masked']['committed'] and x['nonPixel']['refused'] and x['nonPixel']['command']=='filter.draft' and x['undoRedo']['undoRestores'] and x['undoRedo']['redoReapplies'])
cr=d['cameraRaw']
check('camera raw identity is no-op', not cr['identity']['changed'])
check('camera raw curves', cr['pointCurve']['changed'] and cr['pointCurveRed']['changed'])
check('camera raw hsl 3 channels', cr['hslHue']['changed'] and cr['hslSat']['changed'] and cr['hslLum']['changed'], 'band 1/4/5 of the pattern')
check('camera raw hsl off-band control', not cr['hslOffBandNoop']['changed'], 'proves band weighting, not a blanket change')
check('camera raw grade + splits', cr['gradeShadows']['changed'] and cr['curveSplits']['changed'])
check('camera raw bad curve not sent', cr['badCurveBecomesEmpty']==[])
check('lighting effects lights', cr['lights']['single']['changed'] and cr['lights']['pair']['changed'])
vc = d['vanishClone']
check('vanishing point clone', vc['changed'] and vc['copiedRightToLeft'] and vc['rightUntouched'],
      'cross-region sample proves the perspective clone writes pixels')
check('vanishing point clone: planes alone are pixel-neutral', not vc['planesOnlyChanged'])
check('vanishing point clone: malformed entries dropped', vc['malformedDropped'] == 1 and vc['defaultCloneInsideCanvas'])
vp = d['vanishPaste']
check('vanishing point paste: port lists pixel layers', vp['portListsLayers'])
check('vanishing point paste writes layer id', vp['layerIdWritten'])
check('vanishing point paste moves source pixels onto the plane', vp['changed'] and vp['pastedGreenGrew'])
check('vanishing point paste without clipboard layer is refused', vp['missingLayerRefused'])
fp = d['flamePath']
check('flame path: port shape', fp['portShape'])
check('flame path: declared name reaches the kernel', fp['nameReachesKernel'])
check('flame path: default omits the field', fp['defaultOmitsField'] and fp['rendersWithoutPath'])
check('flame path: path.* gated off here (pixel-level check postponed)', fp['pathCommandsGatedOff'])
print()
print('ALL PASS' if ok else 'SOME FAILED')
sys.exit(0 if ok else 1)
