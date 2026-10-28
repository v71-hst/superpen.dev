// Keeps a crash in one part of the UI (a panel, a frame) from tearing down the whole editor.
import React from 'react';
import { log } from '../editor/diagnostics';

type Props = { name: string; children: React.ReactNode; fallback?: (error: Error, reset: () => void) => React.ReactNode; resetKey?: unknown };
type State = { error: Error | null; resetKey?: unknown };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    // A new document version gives the failed part another chance to render.
    if (state.error && props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return { resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    log('error', `render error in ${this.props.name}: ${error.message}`, `${error.stack ?? ''}\n${info.componentStack ?? ''}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, () => this.setState({ error: null }));
    return null;
  }
}

/** Shown in place of a top-level frame that failed to render. */
export function NodeErrorBox({ n, error }: { n: { key: string; props: any }; error: Error }) {
  const p = n.props;
  return (
    <div
      data-k={n.key}
      data-asset-error={`Render error: ${error.message}`}
      title={error.message}
      style={{
        position: 'absolute',
        left: typeof p.x === 'number' ? p.x : 0,
        top: typeof p.y === 'number' ? p.y : 0,
        width: typeof p.width === 'number' ? p.width : 300,
        height: typeof p.height === 'number' ? p.height : 120,
        border: '2px dashed #f43f5e',
        background: 'rgba(244,63,94,0.06)',
        color: '#f43f5e',
        font: '14px system-ui',
        padding: 12,
        overflow: 'hidden',
      }}
    >
      This frame failed to render: {error.message}
    </div>
  );
}
