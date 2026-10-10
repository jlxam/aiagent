// Spike: jsdom + React 19 interactive render + hydration mismatch detection.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { renderToString } = await import('react-dom/server');
const { createRoot, hydrateRoot } = await import('react-dom/client');
const { act } = React;

// --- interactive test ---
function Counter() {
  const [n, setN] = React.useState(0);
  return React.createElement('button', { onClick: () => setN(n + 1) }, `count:${n}`);
}
const container = document.getElementById('root');
const root = createRoot(container);
await act(async () => { root.render(React.createElement(Counter)); });
const btn = container.querySelector('button');
console.log('initial:', btn.textContent);
await act(async () => { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
console.log('after click:', container.querySelector('button').textContent);

// --- hydration mismatch detection with pinned Date ---
const RealDate = Date;
let pinned = RealDate.now();
class MockDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(pinned); else super(...args); }
  static now() { return pinned; }
}
function Stamp() {
  // `Date` resolves the global at call time, so MockDate applies.
  return React.createElement('p', null, new Date().toString());
}
globalThis.Date = MockDate;
pinned = 1770000000000;
const serverHtml = renderToString(React.createElement(Stamp));
pinned = 1770000300000; // +5 min
const recovered = [];
container.innerHTML = serverHtml;
await act(async () => {
  hydrateRoot(container, React.createElement(Stamp), { onRecoverableError: (e) => recovered.push(String(e?.message || e)) });
});
console.log('buggy hydration recoverable errors:', recovered.length, recovered[0]?.slice(0, 90));

// fixed version: useEffect + suppress-free
function StampFixed() {
  const [text, setText] = React.useState('');
  React.useEffect(() => { setText(new Date().toString()); }, []);
  return React.createElement('p', null, text);
}
globalThis.Date = RealDate;
pinned = 1770000000000;
globalThis.Date = MockDate;
const serverHtml2 = renderToString(React.createElement(StampFixed));
pinned = 1770000300000;
const recovered2 = [];
container.innerHTML = serverHtml2;
await act(async () => {
  hydrateRoot(container, React.createElement(StampFixed), { onRecoverableError: (e) => recovered2.push(String(e?.message || e)) });
});
await act(async () => {});
console.log('fixed hydration errors:', recovered2.length, 'text after effects:', JSON.stringify(container.querySelector('p').textContent).slice(0, 60));
globalThis.Date = RealDate;
console.log('SPIKE OK');
