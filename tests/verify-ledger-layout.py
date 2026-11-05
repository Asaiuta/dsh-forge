import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'.tmp-analysis/ledger-layout'
project={'id':'p1','workspace':'/fixture','name':'滚动与导航验收','revision':1,'status':'active','tasks':[{'id':f't{i}','title':f'任务 {i:02d}','status':'pending','note':'长内容测试'} for i in range(24)],'links':[],'reports':[]}
overview={'batches':1,'actors':[{'actor':'Ayari','batches':1}],'files':[{'file':f'src/file-{i}.ts','count':1} for i in range(40)],'lineChanges':{'added':1,'deleted':0,'unavailable':0,'method':'LCS'}}
fixture={'project':project,'overview':overview,'batch':{'id':8,'ts':1,'kind':'edit','actor':'Ayari','reason':'滚动测试','files':[]},
 'git':{'isRepo':True,'toplevel':'/fixture','prefix':'','branch':{'head':'master','upstream':'origin/master','ahead':2,'behind':0,'detached':False,'initial':False},'remotes':['origin'],'staged':[{'path':'src/client/changes/staged.ts','origPath':None,'status':'M','added':4,'removed':1,'binary':False}],'changes':[{'path':'src/client/worktree.ts','origPath':None,'status':'U','added':None,'removed':None,'binary':False}],'conflicts':[],'total':2},
 'gitDiff':{'path':'src/staged.ts','before':{'exists':True,'binary':False,'oversized':False,'text':'old side','bytes':8},'after':{'exists':True,'binary':False,'oversized':False,'text':'new side','bytes':8}}}

FETCH=("data=>{ window.__FORGE_DELEGATE=__FLAG__; window.__forgeOpenCalls=0; window.fetch=async(url,opts={})=>{"
 "const u=new URL(url,document.baseURI);let payload={ok:true};"
 "if(u.pathname.endsWith('forge-git'))payload=u.searchParams.has('file')?{...payload,diff:data.gitDiff}:{...payload,repo:data.git};"
 "else if(u.pathname.endsWith('forge-projects'))payload=u.searchParams.has('projectId')?{...payload,project:data.project,overview:data.overview}:{...payload,projects:[data.project]};"
 "else if(u.searchParams.has('batch'))payload={...payload,batch:data.batch,nodes:[{node:'b8:n0',file:'tail.txt',op:'update',diff:'+'+'line\\\\n'.repeat(300)}]};"
 "else payload={...payload,batches:[data.batch,{...data.batch,id:9,kind:'rollback',reason:'回退测试'},{...data.batch,id:10,kind:'external',reason:'外部改动'}],total:3};"
 "return {ok:true,status:200,text:async()=>JSON.stringify(payload)}}}")

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='msedge')
    for width in [1100,360]:
      for theme in ['light','dark']:
        # One case (1100/light) also exercises the Git delegation path so the
        # synchronous-store-reduce render loop is covered by a real React runtime.
        delegate = (width==1100 and theme=='light')
        page=browser.new_page(viewport={'width':width,'height':720})
        errors=[]
        page.on('pageerror',lambda error: errors.append(str(error)))
        bg,fg=('#f6f7f8','#24262a') if theme=='light' else ('#202226','#e7e9ed')
        page.set_content(f'''<html><head><base href="http://fixture/"><style>
:root{{--dsw-alias-bg-layer-1:{bg};--dsw-alias-bg-layer-2:{'#eceef1' if theme=='light' else '#2c2f35'};--dsw-alias-label-primary:{fg};--dsw-alias-label-secondary:{fg};--dsw-alias-label-tertiary:{fg};--dsw-alias-border-l2:#7777;--dsw-alias-border-l3:#7777;--dsw-alias-interactive-bg-hover:#8882;--dsw-alias-interactive-bg-active:#8883;--dsw-radius-md:8px;--dsw-radius-sm:4px}}
html,body{{height:100%;margin:0;overflow:hidden;background:{bg};color:{fg};font-family:sans-serif}}#host{{height:640px;display:flex;flex-direction:column;overflow:hidden}}#root{{display:flex;flex:1;min-height:0;overflow:hidden}}*{{box-sizing:border-box}}
</style></head><body><div id="host"><div id="root"></div></div></body></html>''')
        page.evaluate(FETCH.replace('__FLAG__','true' if delegate else 'false'),fixture)
        page.add_style_tag(path=str(OUT/'app.css'))
        page.add_script_tag(path=str(OUT/'app.js'))
        page.get_by_label('选择工程',exact=True).select_option('p1')
        page.wait_for_function("document.querySelectorAll('[role=tab]').length===5")
        assert page.get_by_role('tab').all_text_contents()==['计划','施工线','改动文件','详情','Git']
        index=page.get_by_label('工程索引',exact=True)
        assert index.bounding_box()['height']<=48, f'project index is oversized at {width}: {index.bounding_box()}'
        page.get_by_text('工程管理',exact=True).click()
        page.get_by_label('搜索工程',exact=True).fill('滚动')
        page.get_by_text('工程管理',exact=True).click()
        assert index.bounding_box()['height']<=48, 'closing management returns to a single navigation row'
        ledger=page.locator('.dfg-ledger')
        assert ledger.evaluate('(e)=>e.clientHeight<=640')
        assert ledger.evaluate('(e)=>e.scrollHeight>e.clientHeight'), 'long plan must overflow'
        page.mouse.move(width//2,500); page.mouse.wheel(0,700)
        page.wait_for_function("document.querySelector('.dfg-ledger').scrollTop>0")
        ledger.focus(); page.keyboard.press('Home'); page.wait_for_function("document.querySelector('.dfg-ledger').scrollTop===0")
        page.keyboard.press('PageDown'); page.wait_for_function("document.querySelector('.dfg-ledger').scrollTop>0")
        tail=page.get_by_role('button',name='新增任务',exact=True)
        tail.scroll_into_view_if_needed()
        rect=tail.bounding_box(); assert rect['y']>=0 and rect['y']+rect['height']<=640, 'tail action must be reachable'
        for name in ['施工线','改动文件','详情','Git','计划']:
          tab=page.get_by_role('tab',name=name,exact=True);tab.scroll_into_view_if_needed();tab.click()
          assert page.get_by_role('tabpanel').count()==1, 'exactly one accessible page'

        # One selection surface only: the menu above; the plan page carries plan content.
        assert page.get_by_role('combobox',name='选择工程').count()==1, 'the menu is the only project selector'
        assert page.locator('[aria-label="最近计划"]').count()==0, 'no duplicated plan list'
        assert page.locator('.dfg-plan-preview, .dfg-view-panel').first.is_visible()

        page.get_by_role('tab',name='施工线',exact=True).click()
        page.wait_for_selector('.dfg-timeline')
        assert page.locator('.dfg-timeline > button.dfg-batch').count()==3, 'all batches are on the timeline'
        grammar=page.locator('.dfg-timeline > button.dfg-batch')
        dot=grammar.first.evaluate('''e=>{const s=getComputedStyle(e,'::before');return {w:s.width,h:s.height,r:s.borderRadius,c:s.borderTopColor}}''')
        assert dot['w']=='10px' and dot['r']=='50%', f'timeline dot missing: {dot}'
        kinds={}
        for i in range(3):
          kinds[i]=grammar.nth(i).evaluate('e=>getComputedStyle(e,"::before").borderTopColor')
        assert len(set(kinds.values()))>=2, f'kind dots must differ by batch kind: {kinds}'
        card=grammar.first.evaluate('e=>{const s=getComputedStyle(e);return {r:s.borderRadius,b:s.borderTopWidth,w:s.borderTopStyle}}')
        assert card['r']=='10px' and card['b']=='1px' and card['w']!='none', f'batch must render as a bordered card: {card}'

        # --- Git page ---
        before_entering=page.evaluate('window.__forgeOpenCalls||0')
        page.get_by_role('tab',name='Git',exact=True).click()
        if delegate:
          page.wait_for_selector('[aria-label="Git 委派"]')
          # Entering opens exactly once. The earlier tab sweep already visited Git
          # and left, so compare the DELTA rather than an absolute count.
          after=page.evaluate('window.__forgeOpenCalls')
          assert after-before_entering==1, f'one open per entry: delta {after-before_entering}'
          # A render loop would keep opening: the counter must be still afterwards.
          for _ in range(3): page.wait_for_timeout(300)
          settled=page.evaluate('window.__forgeOpenCalls')
          assert settled==after, f'a synchronous store reduce must not re-open: {after} -> {settled}'
          assert not errors, f'delegation must not throw: {errors}'
        else:
          page.wait_for_selector('.dfg-git-branch')
          assert page.locator('.dfg-git-branch').inner_text()=='master'
          letters=page.locator('.dfg-git-letter')
          assert letters.count()==2, f'one status letter per file: {letters.count()}'
          first=letters.first
          assert first.inner_text() in 'MADUR'
          assert first.evaluate('e=>getComputedStyle(e).fontFamily').lower().find('mono')>=0, 'status letter must be monospaced'
          tones={first.get_attribute('data-tone'), letters.nth(1).get_attribute('data-tone')}
          assert len(tones)==2, f'tone must distinguish statuses: {tones}'
          import re as _re
          counts_text=_re.sub(r'\s+','',page.locator('.dfg-git-counts').first.inner_text())
          assert counts_text=='+4−1', f'counts must read +4 −1: {counts_text!r}'
          assert page.locator('.dfg-git-count-pill').count()>=1, 'groups carry a count pill'
          for verb in ['暂存','提交','推送','丢弃']:
            assert page.get_by_role('button',name=verb,exact=False).count()==0, f'git page offers no {verb}'
          # The tree folds the single-child chain instead of repeating near-identical rows.
          assert page.get_by_role('button',name='收起目录 src/client/changes',exact=True).count()==1, 'a single-child chain compresses to one row'
          assert page.get_by_role('button',name='收起目录 src/client',exact=True).count()==1, 'the branching level keeps its own row'
          page.get_by_role('button',name='收起目录 src/client/changes',exact=True).click()
          assert page.get_by_role('button',name='查看差异 src/client/changes/staged.ts',exact=True).count()==0, 'collapsing hides the file'
          page.get_by_role('button',name='展开目录 src/client/changes',exact=True).click()
          page.get_by_role('button',name='查看差异 src/client/changes/staged.ts',exact=True).click()
          page.wait_for_selector('.dfg-dl')
          drow=page.locator('.dfg-dl-row')
          assert drow.count()==1, f'one aligned row: {drow.count()}'
          assert drow.first.get_attribute('data-kind')=='mod', 'a one-for-one rewrite is a mod row'
          assert page.locator('.dfg-dl-mark').inner_text()=='new', 'only the changed characters are marked'
          tint=drow.first.evaluate('e=>getComputedStyle(e).backgroundColor')
          assert tint!='rgba(0, 0, 0, 0)', 'mod rows carry a semantic tint'
          assert page.locator('.dfg-dl-no').count()>=2, 'both gutters render'
          assert page.get_by_role('button',name='← 返回改动列表',exact=True).is_visible()
          page.get_by_role('button',name='← 返回改动列表',exact=True).click()
        assert ledger.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'), 'must not overflow horizontally'
        assert not errors, errors
        page.screenshot(path=str(OUT/f'{width}-{theme}.png'),full_page=True)
        print(f'PASS {width}px {theme}: ' + ('Git delegation (no render loop)' if delegate else 'single-child chain compression, aligned diff rows') + ', navigation, scroll, tail reachability, detail return, no page errors')
        page.close()
    browser.close()
print('4 browser layout cases passed (navigation, scroll, tail reachability, timeline dots per batch kind, bordered batch cards, single-child chain compression with expand/collapse, aligned diff rows with intraline marks, Git delegation without a render loop, read-only Git page with no write controls); 0 failed. Local native-control subset + mocked HTTP, not deployed GUI E2E.')
