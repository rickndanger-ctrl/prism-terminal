import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_ACTIONS, DESKTOP_ACTION_SCRIPT, WINDOW_ACTIONS, executeDesktopAction, navigationURL } from '../src/computer/desktopActions.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  let input = '';
  child.stdin.on('data', data => { input += String(data); });
  return { child, input: () => input };
}

describe('bounded navigation URL', () => {
  it.each([
    '', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'mailto:a@example.com',
    'https://user:pass@example.com/', 'https://user@example.com/', 'https://example.com/\n',
    'https://example.com/hello world', 'https://example.com/"quoted"', "https://example.com/'quoted'",
    'https://example.com/\\evil', 'https://example.com/%0a', 'https://example.com/%00',
    'https://example.com/%C2%85', 'https://example.com:99999/', 'https://example.com/%broken',
    'https://example.com/' + 'x'.repeat(2048), 'https://example.com/' + 'é'.repeat(1024),
  ])('refuses unsafe/invalid target %s', value => { expect(navigationURL(value)).toBeUndefined(); });
  it('allows explicit localhost, query data, and case-sensitive paths without shell interpretation', () => {
    const value = 'http://localhost:8787/CaseSensitive?q=$(hi)&return=/Path#Part';
    expect(navigationURL(value)).toBe(value);
    expect(navigationURL('HTTPS://EXAMPLE.COM')).toBe('https://example.com/');
    expect(navigationURL('https://example.com/hello%20world')).toBe('https://example.com/hello%20world');
  });
});

describe('desktop helper process and outcome boundaries', () => {
  it('matches only exact known Chrome AX title decoration, without fuzzy or cross-browser matches', () => {
    // Execute the actual pure guard from the fixed JXA program. Framework
    // imports are stubbed; run() and every native/UI operation remain uncalled.
    const matches = new Function('ObjC', DESKTOP_ACTION_SCRIPT + '; return browserWindowTitleMatches;')({ import: () => {} }) as (bundle: string, title: unknown, axTitle: unknown) => boolean;
    expect(matches('com.google.Chrome','New Tab','New Tab - Google Chrome')).toBe(true);
    expect(matches('com.google.Chrome','New Tab','New Tab')).toBe(true);
    expect(matches('com.apple.Safari','Example','Example')).toBe(true);
    expect(matches('com.apple.Safari','New Tab','New Tab - Google Chrome')).toBe(false);
    expect(matches('com.google.Chrome','Settings','Other Settings - Google Chrome')).toBe(false);
    expect(matches('com.google.Chrome','New Tab','New Tab - Google Chrome (Private)')).toBe(false);
    expect(matches('com.google.Chrome','New Tab','New Tab - Google Chrome - Google Chrome')).toBe(false);
    expect(matches('com.google.Chrome',undefined,'New Tab - Google Chrome')).toBe(false);
  });
  it('accepts Safari null URL only as the new blank tab representation', () => {
    const matches = new Function('ObjC', DESKTOP_ACTION_SCRIPT + '; return newBlankTabURLMatches;')({ import: () => {} }) as (chrome: boolean, url: unknown) => boolean;
    expect(matches(false,null)).toBe(true);
    expect(matches(false,'about:blank')).toBe(true);
    expect(matches(true,'about:blank')).toBe(true);
    expect(matches(true,null)).toBe(false);
    expect(matches(false,undefined)).toBe(false);
    expect(matches(false,'https://unexpected.example')).toBe(false);
    expect(matches(false,'')).toBe(false);
    // A null URL alone never proves new-tab creation/selection.
    expect(DESKTOP_ACTION_SCRIPT).toContain("check(bw.tabs.length===beforeCount+1, 'focus')");
    expect(DESKTOP_ACTION_SCRIPT).toContain('currentIndex()===beforeCount && newBlankTabURLMatches');
  });
  it('sends only fixed code over stdin and URL only as one data argument', async () => {
    const f = childProcess(), url = 'https://example.com/Case?q=$(literal)&x=1';
    const pending = executeDesktopAction('navigate', url);
    expect(vi.mocked(spawn).mock.calls[0]).toEqual(['/usr/bin/osascript', ['-l', 'JavaScript', '-', 'navigate', url], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }]);
    expect(f.input()).toBe(DESKTOP_ACTION_SCRIPT);
    expect(f.input()).not.toContain(url);
    f.child.stdout.write(JSON.stringify({ status: 'verified', reason: 'navigate' }));
    f.child.emit('close', 0);
    expect(await pending).toContain('Page loading is not verified');
  });
  it.each([
    ['window', 'delete'], ['window', 'restore'], ['browser', 'send'], ['navigate', 'javascript:bad'],
    ['window', 'minimize; do shell script'], ['browser', 'Return'],
  ] as const)('rejects invalid %s action before spawning', async (kind, value) => {
    expect(await executeDesktopAction(kind, value)).toContain('Invalid');
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(WINDOW_ACTIONS)('correlates verified window result %s', async action => {
    const f = childProcess(), pending = executeDesktopAction('window', action);
    f.child.stdout.write(JSON.stringify({ status: 'verified', reason: action })); f.child.emit('close', 0);
    expect(await pending).not.toContain('could not be verified');
    expect(spawn).toHaveBeenCalledOnce();
  });
  it.each(BROWSER_ACTIONS)('does not convert an unverified %s into completion', async action => {
    const f = childProcess(), pending = executeDesktopAction('browser', action);
    f.child.stdout.write(JSON.stringify({ status: 'unknown', reason: 'unverified' })); f.child.emit('close', 0);
    expect(await pending).toContain('could not be verified'); expect(spawn).toHaveBeenCalledOnce();
  });
  it('reload explicitly reports delivery, not loaded page proof', async () => {
    const f = childProcess(), pending = executeDesktopAction('browser', 'reload');
    f.child.stdout.write(JSON.stringify({ status: 'requested', reason: 'reload' })); f.child.emit('close', 0);
    expect(await pending).toBe('Requested a page reload. Page loading is not verified.');
  });
  it('distinguishes supported-but-disabled Safari history from an unsupported action without dispatching twice', async () => {
    const f = childProcess(), pending = executeDesktopAction('browser', 'forward');
    f.child.stdout.write(JSON.stringify({status:'blocked',reason:'noForwardPage'})); f.child.emit('close',0);
    expect(await pending).toBe('Nothing changed. No forward page is available in this tab yet.');
    expect(DESKTOP_ACTION_SCRIPT).toContain('enabledWait<10');
    expect(DESKTOP_ACTION_SCRIPT).toContain('guardBrowser(true); delay(0.05)');
    expect(DESKTOP_ACTION_SCRIPT.match(/AXUIElementPerformAction\(/gu)).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
  });
  it.each(['focus', 'dialog', 'browserOnly', 'lastTab', 'accessibility'])('preserves specific pre-action block %s', async reason => {
    const f = childProcess(), pending = executeDesktopAction('browser', 'closeTab');
    f.child.stdout.write(JSON.stringify({ status: 'blocked', reason })); f.child.emit('close', 0);
    const summary = await pending;
    expect(summary).not.toContain('Closed'); expect(summary).not.toContain('could not be verified');
  });
  it.each(['{"status":"verified","reason":"closeTab"}', 'null', '[]', '{broken', '{"status":"blocked","reason":"__proto__"}'])('does not trust mismatched or malformed result %s', async output => {
    const f = childProcess(), pending = executeDesktopAction('window', 'left');
    f.child.stdout.write(output); f.child.emit('close', 0);
    expect(typeof await pending).toBe('string');
    expect(await pending).not.toContain('Moved');
  });
  it('terminates bounded work on timeout without any retry', async () => {
    vi.useFakeTimers();
    const f = childProcess(), pending = executeDesktopAction('browser', 'newTab');
    await vi.advanceTimersByTimeAsync(7000);
    expect(await pending).toContain('no automatic retry'); expect(f.child.kill).toHaveBeenCalledOnce(); expect(spawn).toHaveBeenCalledOnce();
  });
  it('fails closed on oversized output and process errors', async () => {
    const f = childProcess(), pending = executeDesktopAction('browser', 'newTab');
    f.child.stdout.write('x'.repeat(513));
    expect(await pending).toContain('could not be verified'); expect(f.child.kill).toHaveBeenCalledOnce();
    const g = childProcess(), unavailable = executeDesktopAction('browser', 'newTab');
    g.child.emit('error', new Error('missing'));
    expect(await unavailable).toContain('Nothing changed');
  });
  it('has stable target guards, no shell/web JS/keyboard fallback, and no last-tab closing', () => {
    expect(DESKTOP_ACTION_SCRIPT).toContain('current.processIdentifier===pid');
    expect(DESKTOP_ACTION_SCRIPT).toContain('same(focused,window)');
    expect(DESKTOP_ACTION_SCRIPT).toContain("array(window,'AXSheets').length===0");
    expect(DESKTOP_ACTION_SCRIPT).toContain('currentTab().id()===beforeID');
    expect(DESKTOP_ACTION_SCRIPT).toContain('function guardSameTab()');
    expect(DESKTOP_ACTION_SCRIPT).toContain('currentTab().id()===addedID');
    expect(DESKTOP_ACTION_SCRIPT.match(/bw\.tabs\.push\(/gu)).toHaveLength(1);
    expect(DESKTOP_ACTION_SCRIPT).toContain("check(beforeCount>1, 'lastTab')");
    expect(DESKTOP_ACTION_SCRIPT).not.toMatch(/doShellScript|doJavaScript|keyCode|keystroke|CGEvent|NSPasteboard/u);
    expect(() => new Function(DESKTOP_ACTION_SCRIPT)).not.toThrow();
  });
});
