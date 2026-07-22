import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { BrowserState } from '../../shared/contracts';
import { IconButton } from './IconButton';

interface BrowserPanelProps {
  onClose: () => void;
  visible: boolean;
}

const initialState: BrowserState = {
  url: 'https://www.google.com/',
  title: '新标签页',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
};

function normalizeAddress(input: string) {
  const value = input.trim();
  if (!value) return initialState.url;

  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(value)) {
    return `http://${value}`;
  }
  if (value.includes('.') && !value.includes(' ')) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export function BrowserPanel({ onClose, visible }: BrowserPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<BrowserState>(initialState);
  const [address, setAddress] = useState(initialState.url);
  const [addressFocused, setAddressFocused] = useState(false);
  const [bridgeAvailable, setBridgeAvailable] = useState(() => Boolean(window.workbench?.browser));
  const browserApi = window.workbench?.browser;

  useEffect(() => {
    let active = true;

    if (!browserApi) {
      return;
    }

    void browserApi
      .getState()
      .then((nextState) => {
        if (active) {
          setState(nextState);
          if (!addressFocused) setAddress(nextState.url || initialState.url);
        }
      })
      .catch(() => setBridgeAvailable(false));

    const unsubscribe = browserApi.onStateChange((nextState) => {
      if (!active) return;
      setState(nextState);
      if (!addressFocused) setAddress(nextState.url);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [addressFocused, browserApi]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !browserApi) return;
    if (!visible) {
      void browserApi.setVisible(false);
      return;
    }

    let animationFrame = 0;
    const syncBounds = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        void browserApi.setBounds({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
        void browserApi.setVisible(true);
      });
    };

    const resizeObserver = new ResizeObserver(syncBounds);
    resizeObserver.observe(viewport);
    window.addEventListener('resize', syncBounds);
    syncBounds();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncBounds);
      void browserApi.setVisible(false);
    };
  }, [browserApi, visible]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const nextAddress = normalizeAddress(address);
    setAddress(nextAddress);
    addressRef.current?.blur();
    if (!browserApi) return;
    void browserApi
      .navigate(nextAddress)
      .then(setState)
      .catch(() => setBridgeAvailable(false));
  };

  const invoke = (action: 'back' | 'forward' | 'reload' | 'stop') => {
    if (!browserApi) return;
    void browserApi[action]()
      .then(setState)
      .catch(() => setBridgeAvailable(false));
  };

  return (
    <aside className="browser-panel" aria-label="内置浏览器">
      <div className="browser-tabs">
        <div className="browser-tab is-active">
          {state.isLoading ? (
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          ) : (
            <Globe2 size={14} aria-hidden="true" />
          )}
          <span>{state.title || '新标签页'}</span>
          <IconButton label="关闭标签页" tooltipSide="bottom" onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </IconButton>
        </div>
        <IconButton
          label="新建标签页"
          tooltipSide="bottom"
          onClick={() => {
            setAddress(initialState.url);
            if (browserApi) void browserApi.navigate(initialState.url).then(setState);
          }}
        >
          <Plus size={15} aria-hidden="true" />
        </IconButton>
        <span className="browser-tabs__spacer" />
        <IconButton label="浏览器选项" tooltipSide="left">
          <MoreHorizontal size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="browser-toolbar">
        <IconButton label="后退" disabled={!state.canGoBack} onClick={() => invoke('back')}>
          <ArrowLeft size={16} aria-hidden="true" />
        </IconButton>
        <IconButton label="前进" disabled={!state.canGoForward} onClick={() => invoke('forward')}>
          <ArrowRight size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={state.isLoading ? '停止加载' : '刷新'}
          onClick={() => invoke(state.isLoading ? 'stop' : 'reload')}
        >
          {state.isLoading ? <X size={15} /> : <RefreshCw size={15} />}
        </IconButton>

        <form className="address-bar" onSubmit={navigate}>
          {address.startsWith('https:') ? (
            <LockKeyhole size={13} aria-label="安全连接" />
          ) : (
            <Search size={13} aria-hidden="true" />
          )}
          <label className="sr-only" htmlFor="browser-address">
            网址或搜索内容
          </label>
          <input
            ref={addressRef}
            id="browser-address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              setAddressFocused(true);
              event.currentTarget.select();
            }}
            onBlur={() => setAddressFocused(false)}
            spellCheck={false}
            autoComplete="off"
          />
        </form>
      </div>

      <div ref={viewportRef} className="browser-viewport">
        {!bridgeAvailable ? (
          <div className="browser-fallback">
            <span>
              <ShieldCheck size={22} />
            </span>
            <strong>安全浏览区域</strong>
            <p>浏览器会在 Electron 应用中启用。</p>
          </div>
        ) : (
          <div className="browser-surface-hint" aria-hidden="true">
            <Globe2 size={24} />
          </div>
        )}
      </div>
    </aside>
  );
}
