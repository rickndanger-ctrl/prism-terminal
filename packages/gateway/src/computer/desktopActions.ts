import { spawn } from 'node:child_process';

export const WINDOW_ACTIONS = ['minimize', 'maximize', 'left', 'right'] as const;
export const BROWSER_ACTIONS = ['back', 'forward', 'reload', 'newTab', 'nextTab', 'previousTab', 'closeTab', 'focusAddress'] as const;

export function navigationURL(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- reject control bytes at the navigation boundary
  if (!value || Buffer.byteLength(value, 'utf8') > 2048 || /[\s\u0000-\u001f\u007f-\u009f"'\\]/u.test(value)) return undefined;
  try {
    // eslint-disable-next-line no-control-regex -- encoded controls must not bypass the same boundary
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(decodeURIComponent(value))) return undefined;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

// Fixed JXA program, not generated from the request. The two argv values are
// data only. No shell, arbitrary key codes, web-page JS, clipboard, or Send.
// Native AX references guard the current PID/window across scripting calls.
export const DESKTOP_ACTION_SCRIPT = String.raw`
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
function browserWindowTitleMatches(bundle, scriptingTitle, accessibilityTitle) {
  // Chrome's AX window title can add this exact native app decoration. Never
  // use substring/fuzzy matching: another page with a similar title is not it.
  return typeof scriptingTitle==='string' && typeof accessibilityTitle==='string' &&
    (accessibilityTitle===scriptingTitle ||
      (bundle==='com.google.Chrome' && accessibilityTitle===scriptingTitle+' - Google Chrome'));
}
function newBlankTabURLMatches(chrome, url) {
  // Safari exposes a newly created blank tab's URL as null. This is accepted
  // only alongside the exact +1 tab count and selected new-tab index checks.
  return url==='about:blank' || (!chrome && url===null);
}
function run(argv) {
  var attempted = false;
  function result(status, reason) { return JSON.stringify({status:status, reason:reason}); }
  function attr(element, name) {
    var ref = Ref();
    if (!element || $.AXUIElementCopyAttributeValue(element, $(name), ref) !== 0) return null;
    return ObjC.castRefToObject(ref[0]);
  }
  function scalar(element, name) { var v=attr(element,name); return v ? ObjC.unwrap(v) : null; }
  function array(element, name) {
    var v=attr(element,name), out=[];
    if (v) for(var i=0;i<Number(v.count);i++) out.push(v.objectAtIndex(i));
    return out;
  }
  function same(a,b) { return !!a && !!b && $.CFEqual(a,b); }
  function check(condition, reason) { if(!condition) throw new Error(reason); }
  try {
    check(argv.length===2, 'invalid');
    var kind=argv[0], action=argv[1];
    check((kind==='window' && ['minimize','maximize','left','right'].indexOf(action)>=0) ||
      (kind==='browser' && ['back','forward','reload','newTab','nextTab','previousTab','closeTab','focusAddress'].indexOf(action)>=0) || kind==='navigate', 'invalid');
    check($.AXIsProcessTrusted(), 'accessibility');
    var front=$.NSWorkspace.sharedWorkspace.frontmostApplication;
    check(!!front, 'unsupported');
    var pid=front.processIdentifier, bundle=ObjC.unwrap(front.bundleIdentifier), app=$.AXUIElementCreateApplication(pid);
    var window=attr(app,'AXFocusedWindow');
    check(!!window && scalar(window,'AXRole')==='AXWindow' && scalar(window,'AXSubrole')==='AXStandardWindow', 'unsupported');
    function guardTarget(requireFocus) {
      var current=$.NSWorkspace.sharedWorkspace.frontmostApplication;
      check(!!current && current.processIdentifier===pid, 'focus');
      check(array(app,'AXWindows').some(function(w){return same(w,window);}), 'focus');
      check(scalar(window,'AXModal')!==true && array(window,'AXSheets').length===0, 'dialog');
      var focused=attr(app,'AXFocusedWindow');
      if(focused) check(scalar(focused,'AXModal')!==true && scalar(focused,'AXSubrole')!=='AXDialog' && array(focused,'AXSheets').length===0, 'dialog');
      if(requireFocus) check(same(focused,window), 'focus');
    }
    guardTarget(true);
    if(kind==='window') {
      check(scalar(window,'AXFullScreen')!==true, 'fullscreen');
      if(action==='minimize') {
        var minimizedState=true;
        attempted=true;
        check($.AXUIElementSetAttributeValue(window,$('AXMinimized'),$(minimizedState))===0, 'unverified');
        for(var m=0;m<8;m++) {
          if(scalar(window,'AXMinimized')===minimizedState) return result('verified',action);
          delay(0.025);
        }
        return result('unknown','unverified');
      }
      // Geometry goes through the existing System Events automation identity.
      // Match one exact standard window, never a largest-window heuristic.
      var title=scalar(window,'AXTitle'), se=Application('System Events');
      var process=se.applicationProcesses.whose({unixId:pid})[0];
      var matches=process.windows().filter(function(w){ return w.name()===title; });
      check(matches.length===1, 'unsupported');
      var uiWindow=matches[0], pos=uiWindow.position(), size=uiWindow.size();
      var screens=$.NSScreen.screens, primary=screens.objectAtIndex(0).frame;
      var top=primary.origin.y+primary.size.height, best=null, bestArea=0;
      for(var n=0;n<Number(screens.count);n++) {
        var screen=screens.objectAtIndex(n), frame=screen.frame;
        var sx=frame.origin.x, sy=top-frame.origin.y-frame.size.height;
        var area=Math.max(0,Math.min(pos[0]+size[0],sx+frame.size.width)-Math.max(pos[0],sx))*
          Math.max(0,Math.min(pos[1]+size[1],sy+frame.size.height)-Math.max(pos[1],sy));
        if(area>bestArea) { best=screen.visibleFrame; bestArea=area; }
      }
      check(!!best, 'unsupported');
      var x=Math.round(best.origin.x), y=Math.round(top-best.origin.y-best.size.height);
      var width=Math.round(best.size.width), height=Math.round(best.size.height);
      if(action==='left' || action==='right') {
        var half=Math.floor(width/2);
        if(action==='right') { x+=half; width-=half; } else width=half;
      }
      guardTarget(true); check(uiWindow.name()===title, 'focus');
      attempted=true;
      uiWindow.position=[x,y];
      guardTarget(true);
      uiWindow.size=[width,height];
      guardTarget(true);
      uiWindow.position=[x,y];
      for(var g=0;g<6;g++) {
        guardTarget(true);
        var actualPos=uiWindow.position(), actualSize=uiWindow.size();
        if(Math.abs(actualPos[0]-x)<=2 && Math.abs(actualPos[1]-y)<=2 && Math.abs(actualSize[0]-width)<=2 && Math.abs(actualSize[1]-height)<=2) return result('verified',action);
        delay(0.025);
      }
      return result('unknown','unverified');
    }
    check(bundle==='com.google.Chrome' || bundle==='com.apple.Safari', 'browserOnly');
    var chrome=bundle==='com.google.Chrome', browser=Application(bundle);
    check(browser.windows.length>0, 'unsupported');
    var bw=browser.windows[0], windowID=bw.id();
    var beforeCount=bw.tabs.length;
    check(beforeCount>0, 'unsupported');
    function currentTab() { return chrome ? bw.activeTab() : bw.currentTab(); }
    function currentIndex() { return chrome ? bw.activeTabIndex()-1 : bw.currentTab().index()-1; }
    var beforeIndex=currentIndex(), tab=currentTab(), beforeURL=tab.url();
    var beforeID=chrome ? tab.id() : null;
    // The scripting window must be the visible AX window, not a hidden page
    // behind a Preferences/dialog window.
    check(browserWindowTitleMatches(bundle,bw.name(),scalar(window,'AXTitle')), 'unsupported');
    function guardBrowser(unchangedTab) {
      guardTarget(true);
      check(browser.windows.length>0 && browser.windows[0].id()===windowID && bw.id()===windowID, 'focus');
      if(unchangedTab) {
        check(bw.tabs.length===beforeCount && currentIndex()===beforeIndex, 'focus');
        if(chrome) check(currentTab().id()===beforeID, 'focus');
        else check(currentTab().url()===beforeURL, 'focus');
      }
    }
    function guardSameTab() {
      guardBrowser(false);
      check(bw.tabs.length===beforeCount && currentIndex()===beforeIndex && (!chrome || currentTab().id()===beforeID), 'focus');
    }
    function pressMenuKey(char) {
      // Resolve the unique native browser menu accelerator. This invokes an
      // AX menu action on the captured browser, not global synthetic typing.
      var menuBar=attr(app,'AXMenuBar'), pending=menuBar ? [{e:menuBar,d:0}] : [], found=[], scanned=0;
      while(pending.length && scanned<400) {
        var node=pending.shift(); scanned++;
        if(scalar(node.e,'AXRole')==='AXMenuItem' && String(scalar(node.e,'AXMenuItemCmdChar')).toLowerCase()===char && Number(scalar(node.e,'AXMenuItemCmdModifiers'))===0) found.push(node.e);
        if(node.d<4) array(node.e,'AXChildren').forEach(function(e){pending.push({e:e,d:node.d+1});});
      }
      check(!pending.length && found.length===1, 'menuUnavailable');
      // Safari can briefly disable Forward while the prior history navigation
      // commits. Wait only for this one native item's enabled state; never
      // repeat an action or lose the original tab/window ownership checks.
      for(var enabledWait=0;enabledWait<10 && scalar(found[0],'AXEnabled')!==true;enabledWait++) {
        guardBrowser(true); delay(0.05);
      }
      check(scalar(found[0],'AXEnabled')===true, action==='back'?'noBackPage':action==='forward'?'noForwardPage':'menuUnavailable');
      guardBrowser(true); attempted=true;
      check($.AXUIElementPerformAction(found[0],$('AXPress'))===0, 'unverified');
    }
    if(kind==='navigate') {
      guardBrowser(true); attempted=true; tab.url=action;
      for(var u=0;u<8;u++) {
        guardSameTab();
        if(currentTab().url()===action) return result('verified','navigate');
        delay(0.025);
      }
      return result('requested','navigate');
    }
    if(action==='nextTab' || action==='previousTab') {
      check(beforeCount>1, 'oneTab');
      var targetIndex=(beforeIndex+(action==='nextTab'?1:beforeCount-1))%beforeCount;
      var wantedID=chrome ? bw.tabs[targetIndex].id() : null;
      guardBrowser(true); attempted=true;
      if(chrome) bw.activeTabIndex=targetIndex+1; else bw.currentTab=bw.tabs[targetIndex];
      for(var t=0;t<8;t++) {
        guardBrowser(false); check(bw.tabs.length===beforeCount, 'focus');
        if(currentIndex()===targetIndex && (!chrome || currentTab().id()===wantedID)) return result('verified',action);
        delay(0.025);
      }
      return result('unknown','unverified');
    }
    if(action==='newTab') {
      guardBrowser(true); attempted=true;
      bw.tabs.push(browser.Tab({url:'about:blank'}));
      for(var made=0;made<8 && bw.tabs.length===beforeCount;made++) { guardBrowser(false); delay(0.025); }
      check(bw.tabs.length===beforeCount+1, 'unverified');
      guardBrowser(false);
      var addedID=chrome ? bw.tabs[beforeCount].id() : null;
      if(chrome) bw.activeTabIndex=beforeCount+1; else bw.currentTab=bw.tabs[beforeCount];
      for(var selected=0;selected<8;selected++) {
        guardBrowser(false); check(bw.tabs.length===beforeCount+1, 'focus');
        if(currentIndex()===beforeCount && newBlankTabURLMatches(chrome,currentTab().url()) && (!chrome || currentTab().id()===addedID)) return result('verified',action);
        delay(0.025);
      }
      return result('unknown','unverified');
    }
    if(action==='closeTab') {
      check(beforeCount>1, 'lastTab');
      guardBrowser(true); attempted=true; tab.close();
      for(var c=0;c<8;c++) {
        guardBrowser(false);
        if(bw.tabs.length===beforeCount-1 && (!chrome || !bw.tabs().some(function(t){return t.id()===beforeID;}))) return result('verified',action);
        delay(0.025);
      }
      return result('unknown','unverified');
    }
    if(action==='focusAddress') {
      pressMenuKey('l');
      guardSameTab();
      var field=attr(app,'AXFocusedUIElement'), role=scalar(field,'AXRole'), ancestor=field;
      var inToolbar=false;
      for(var p=0;p<12 && ancestor;p++) {
        if(scalar(ancestor,'AXRole')==='AXToolbar') { inToolbar=true; break; }
        ancestor=attr(ancestor,'AXParent');
      }
      if(inToolbar && ['AXTextField','AXComboBox'].indexOf(role)>=0) return result('verified',action);
      return result('requested',action);
    }
    if(chrome) {
      guardBrowser(true); attempted=true;
      if(action==='back') tab.goBack();
      else if(action==='forward') tab.goForward();
      else tab.reload();
    } else pressMenuKey(action==='back'?'[':action==='forward'?']':'r');
    guardSameTab();
    if(action!=='reload') for(var history=0;history<8;history++) {
      guardSameTab();
      if(currentTab().url()!==beforeURL) return result('verified',action);
      delay(0.025);
    }
    // A delivered reload/history request is not proof the remote page loaded.
    return result('requested',action);
  } catch(error) {
    var reason=String(error.message || error);
    var known=['invalid','accessibility','unsupported','focus','dialog','fullscreen','unverified','browserOnly','menuUnavailable','noBackPage','noForwardPage','oneTab','lastTab'];
    return result(attempted?'unknown':'blocked',known.indexOf(reason)>=0?reason:'unavailable');
  }
}
`;

const verified: Record<string, string> = {
  minimize: 'Minimized the window.',
  maximize: 'Maximized the window.', left: 'Moved the window to the left half.', right: 'Moved the window to the right half.',
  back: 'Went back a page.', forward: 'Went forward a page.',
  newTab: 'Opened a new browser tab.', nextTab: 'Switched to the next tab.', previousTab: 'Switched to the previous tab.',
  closeTab: 'Closed the current tab.', focusAddress: 'Focused the browser address bar.',
  navigate: 'Opened the address in the current tab. Page loading is not verified.',
};
const requested: Record<string, string> = {
  reload: 'Requested a page reload. Page loading is not verified.',
  back: 'Requested browser back. A page change is not verified.',
  forward: 'Requested browser forward. A page change is not verified.',
  focusAddress: 'Requested address bar focus. Check the browser before typing.',
  navigate: 'Requested the address. Page loading is not verified.',
};
const blocked: Record<string, string> = {
  accessibility: 'Nothing changed. The Mac automation helper needs Accessibility permission.',
  focus: 'Nothing changed. The active app or window changed.',
  dialog: 'Nothing changed. Close the dialog on your Mac first.',
  fullscreen: 'Nothing changed. Leave full-screen mode before arranging this window.',
  browserOnly: 'Nothing changed. Bring Chrome or Safari to the front first.',
  oneTab: 'There is only one tab. Nothing changed.',
  lastTab: 'I left the last tab open. Ask to close the window instead.',
  menuUnavailable: 'Nothing changed. That browser menu action is unavailable.',
  noBackPage: 'Nothing changed. No previous page is available in this tab yet.',
  noForwardPage: 'Nothing changed. No forward page is available in this tab yet.',
};
const unknown = 'The action could not be verified. Check your Mac before retrying; no automatic retry was made.';

export async function executeDesktopAction(kind: 'window' | 'browser' | 'navigate', value: string): Promise<string> {
  if (!['window', 'browser', 'navigate'].includes(kind) || (kind === 'window' && !WINDOW_ACTIONS.some(x => x === value)) ||
      (kind === 'browser' && !BROWSER_ACTIONS.some(x => x === value)) ||
      (kind === 'navigate' && !navigationURL(value))) return 'Nothing changed. Invalid computer command.';
  const argument = kind === 'navigate' ? navigationURL(value)! : value;
  return new Promise(resolve => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-', kind, argument], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', settled = false;
    const finish = (summary: string) => { if (settled) return; settled = true; clearTimeout(timer); resolve(summary); };
    const timer = setTimeout(() => { child.kill(); finish(unknown); }, 7000);
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8');
      if (output.length > 512) { child.kill(); finish(unknown); }
    });
    child.once('error', () => finish('Nothing changed. The Mac automation helper is unavailable.'));
    child.once('close', code => {
      if (code !== 0) { finish(unknown); return; }
      try {
        const result = JSON.parse(output) as { status?: unknown; reason?: unknown };
        const expected = kind === 'navigate' ? 'navigate' : value;
        if (result.status === 'verified' && result.reason === expected && verified[expected]) finish(verified[expected]);
        else if (result.status === 'requested' && result.reason === expected && requested[expected]) finish(requested[expected]);
        else if (result.status === 'blocked' && typeof result.reason === 'string') finish(Object.hasOwn(blocked, result.reason) ? blocked[result.reason]! : 'Nothing changed. This app or window does not support that command.');
        else finish(unknown);
      } catch { finish(unknown); }
    });
    child.stdin.end(DESKTOP_ACTION_SCRIPT);
  });
}
