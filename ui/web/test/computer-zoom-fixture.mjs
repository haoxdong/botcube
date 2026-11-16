import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
/** @typedef {[number, number, number]} TouchPoint */
/** @typedef {Document & {createTouch:(window:Window,target:Element,id:number,pageX:number,pageY:number,screenX:number,screenY:number)=>Touch,createTouchList:(...touches:Touch[])=>TouchList}} TouchDocument */
/** @typedef {{onResolve:(options:{filter:RegExp},callback:()=>{path:string,namespace:string})=>void,onLoad:(options:{filter:RegExp,namespace:string},callback:(args:{path:string})=>{contents:string,loader:string,resolveDir:string})=>void}} FixtureBuilder */

export async function startComputerFixture() {
  const root = resolve(import.meta.dirname, '../../../..');
  // The installed viewer and bundler, wherever pnpm's virtual store keeps them.
  const bedrock = resolve(
    realpathSync(
      resolve(root, 'botcube/ui/web/node_modules/bedrock-agentcore')
    ),
    'dist/src/tools/browser/live-view/nice-dcv-web-client-sdk/dcvjs-esm/dcv.js'
  );
  const vite = createRequire(
    createRequire(resolve(root, 'package.json')).resolve('vitest/package.json')
  ).resolve('vite/package.json');
  const { build } =
    /** @type {{build:(options:unknown)=>Promise<{outputFiles:Array<{text:string}>}>}} */ (
      await import(createRequire(vite).resolve('esbuild'))
    );
  const sdk = await readFile(bedrock, 'utf8');
  assert(
    sdk.includes('class Dc extends Ac') && sdk.includes('function Zc(A,e)'),
    'installed DCV input receiver changed; update connected fixture'
  );
  const sdkFixture = `${sdk}\nexport function attachInput(target, native) {
 const packets = window.computerTrace.packets;
 const display = { displayDiv: target, highPixelDensityEnabled: false, xOffset:0, yOffset:0 };
 const manager = { getScaleRatio:()=>null, translateCoordinates:(x,y)=>Zc.call(display,x,y), currentServerTime:()=>0, focusDisplayDiv:()=>{}, captureMouse:()=>{}, isMouseCaptured:()=>false, releaseMouse:()=>{}, isPointInsideDisplay:()=>false, setVirtualCursor:()=>{}, setRenderCursor:()=>{} };
 const id='computer-acceptance';
 Xa[id]={configuration:{divId:'dcv-display'},getTrackpadMode:()=>false,channelManager:{getDataChannel:(channel)=>channel===Co.DISPLAY?{getDisplayManager:()=>manager}:null}};
 const receiver=new Dc(id,()=>{}); receiver.setTouchSupported(native);
 receiver.lastTouchEnded=document.createTouch(window,target,0,0,0,0,0);
 receiver.registerChannel({sendInputMessage:(packet)=>packets.push(packet)});
 const listeners={touchstart:receiver.onTouchStart,touchmove:receiver.onTouchMove,touchend:receiver.onTouchEnd,touchcancel:receiver.onTouchCancel,mousedown:receiver.onMouseDown,mouseup:receiver.onMouseUp,mousemove:receiver.onMouseMove};
 for(const [name,handler] of Object.entries(listeners)) target.addEventListener(name,event=>handler.call(receiver,event,0));
 target.addEventListener('keydown',event=>packets.push({key:event.key}));
 return {dispose:()=>receiver.unregisterChannel(),getTrackpadMode:()=>receiver.touchTrackPadMode.enabled,setTrackpadMode:value=>receiver.setTrackpadMode(value)};
}`;
  const fixture = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AgentComputer} from '${root}/botcube/ui/web/src/computer/agent-computer.tsx';
import {AgentProfile} from '${root}/botcube/ui/web/src/app/agent-profile.tsx';
import {ChatComputers} from '${root}/botcube/ui/web/src/app/chat-computers.tsx';
window.computerTrace={packets:[],mounts:0,takeovers:0,returns:0};
function View({shown,onConnectionChange}){
 const [control,setControl]=useState('agent'),[busy,setBusy]=useState(false),[error,setError]=useState(null);
 window.computerFixture??={clear:()=>window.computerTrace.packets.length=0,failReturn:false,failTakeover:false};
 const change=(next)=>{setBusy(true);setError(null); if(next==='user')window.computerTrace.takeovers++;else window.computerTrace.returns++;setTimeout(()=>{setBusy(false);if((next==='agent'&&window.computerFixture.failReturn)||(next==='user'&&window.computerFixture.failTakeover))setError('Control request failed');else setControl(next)},150)};
 return <AgentComputer active={shown} onConnectionChange={onConnectionChange} agentName="Marq" chatId="fixture" app="Chrome" files={null} computer={{state:'awake',browserSessionId:'fixture',control,screenshot:null}} commands={[]} control={control} running={false} busy={busy} error={error} notice={null} onTakeOver={()=>change('user')} onHandBack={()=>change('agent')} starting={false} onStop={()=>{}} onOpenApp={()=>{}} />;
}
const agent={messages:[],isRunning:false,subscribe:()=>({unsubscribe(){}})};
const current={conversation:{id:'fixture'},agent};
function App(){
 const [open,setOpen]=useState(true);
 return <div className="app-layout" style={{height:'100dvh'}}><button aria-label="Agent profile" onClick={()=>setOpen(true)}>Profile</button><AgentProfile open={open} chatServiceUrl="fixture" profile={{name:'Marq',avatar:'',picture:null,status:'online'}} error={null} onClose={()=>setOpen(false)} revision={0} onSaved={()=>{}} computer={shown=><ChatComputers current={current} View={View} agentId="fixture" agentName="Marq" shown={shown} stop={null}/>} /></div>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
  const viewer = `import React,{useLayoutEffect,useRef} from 'react';
import {attachInput} from '/sdk.js';
export function BrowserLiveView({onConnectionEstablished,onDisconnect}){
 const host=useRef(null);
 useLayoutEffect(()=>{
 window.computerTrace.mounts++;
 window.computerFixture.disconnect=()=>onDisconnect('fixture disconnected');
 const box=host.current,display=box.querySelector('#dcv-display'),input=box.querySelector('#dcv-input');
 const fit=()=>{const r=box.getBoundingClientRect(),scale=Math.min(r.width/1280,r.height/720);display.style.transform='scale('+scale+')';};
 fit();const observer=new ResizeObserver(fit);observer.observe(box);
 const detach=attachInput(input,new URLSearchParams(location.search).get('native')!=='false');
 queueMicrotask(()=>onConnectionEstablished({sendKeyboardShortcut:keys=>window.computerTrace.packets.push({keys}),getTrackpadMode:()=>detach.getTrackpadMode(),setTrackpadMode:value=>detach.setTrackpadMode(value),syncClipboards:()=>false}));
 return ()=>{observer.disconnect();detach.dispose();};
 },[]);
 return <div ref={host} style={{position:'absolute',inset:0}}><div id="dcv-display" style={{position:'absolute',width:1280,height:720,transformOrigin:'top left',background:'#17324d'}}><canvas width="1280" height="720"/><div id="dcv-input" tabIndex="0" style={{position:'absolute',inset:0}}/></div></div>;
}`;
  const bundled = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: root },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    external: ['/sdk.js'],
    alias: { '@cartridge-ui': resolve(root, 'botcube/ui/web/src/cartridge/default.tsx') },
    nodePaths: [resolve(root, 'botcube/ui/web/node_modules')],
    plugins: [
      {
        name: 'connected-viewer',
        /** @param {FixtureBuilder} builder */
        setup(builder) {
          builder.onResolve({ filter: /^next\/dynamic$/ }, () => ({
            path: 'dynamic',
            namespace: 'fixture',
          }));
          builder.onResolve(
            { filter: /^bedrock-agentcore\/browser\/live-view$/ },
            () => ({ path: 'viewer', namespace: 'fixture' })
          );
          builder.onResolve({ filter: /browser-live-view-url$/ }, () => ({
            path: 'url',
            namespace: 'fixture',
          }));
          builder.onLoad(
            { filter: /.*/, namespace: 'fixture' },
            ({ path }) => ({
              contents:
                path === 'viewer'
                  ? viewer
                  : path === 'url'
                    ? 'export const fetchBrowserLiveViewSignedUrl=async()=>"fixture";'
                    : 'import React from "react"; export default (load)=>{const View=React.lazy(()=>load().then(defaultExport=>({default:defaultExport})));return props=><React.Suspense fallback={null}><View {...props}/></React.Suspense>}',
              loader: 'tsx',
              resolveDir: resolve(root, 'botcube/ui/web'),
            })
          );
        },
      },
    ],
  });
  const bundle = bundled.outputFiles[0];
  assert(bundle, 'fixture bundler produced its application');
  const css = (
    await Promise.all(
      [
        'botcube/ui/web/src/app/globals.css',
        'botcube/ui/web/src/computer/styles.css',
        'botcube/ui/web/src/computer/files-menu.css',
      ].map((file) => readFile(resolve(root, file), 'utf8'))
    )
  )
    .join('\n')
    // globals.css's sheets by surface inlined, as Tailwind bundles them; its package imports dropped.
    .replace(/^@import "\.\/([\w-]+\.css)";$/gm, (_line, file) => readFileSync(resolve(root, 'botcube/ui/web/src/app', file), 'utf8'))
    .replace(/^@import.*$/gm, '');
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    response.setHeader(
      'content-type',
      url.pathname.endsWith('.js')
        ? 'application/javascript'
        : url.pathname.endsWith('.css')
          ? 'text/css'
          : 'text/html'
    );
    response.end(
      url.pathname === '/sdk.js'
        ? sdkFixture
        : url.pathname === '/app.js'
          ? bundle.text
          : url.pathname === '/style.css'
            ? css
            : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'
    );
  });
  await new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', () => resolveListen(undefined))
  );
  const address = server.address();
  assert(
    address && typeof address !== 'string',
    'fixture server has an address'
  );
  const base = `http://127.0.0.1:${address.port}`;
  return { server, base };
}

/** @param {import("playwright").Page} page @param {string} type @param {TouchPoint[]} points @param {TouchPoint[]} changed */
export async function touch(page, type, points, changed = points) {
  await page.evaluate(
    ({ type, points, changed }) => {
      const target = document.getElementById('dcv-input');
      if (!target) throw new Error('SDK input is missing');
      const touchDocument = /** @type {TouchDocument} */ (document);
      /** @param {TouchPoint} point */
      const make = ([identifier, x, y]) =>
        touchDocument.createTouch(window, target, identifier, x, y, x, y);
      target.dispatchEvent(
        new TouchEvent(
          type,
          /** @type {TouchEventInit} */ (
            /** @type {unknown} */ ({
              bubbles: true,
              cancelable: true,
              touches: touchDocument.createTouchList(...points.map(make)),
              targetTouches: touchDocument.createTouchList(...points.map(make)),
              changedTouches: touchDocument.createTouchList(
                ...changed.map(make)
              ),
            })
          )
        )
      );
    },
    { type, points, changed }
  );
}
