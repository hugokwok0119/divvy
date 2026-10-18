import React from 'react';

interface State { error: Error | null }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Divvy crashed:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
        <div className="max-w-md w-full bg-white rounded-xl shadow p-6 text-center">
          <h1 className="text-heading1 font-semibold text-slate-900">Something broke</h1>
          <p className="mt-2 text-sm text-slate-600">
            Your data is safe on the server. Reloading usually fixes this.
          </p>
          <pre className="mt-4 text-left text-xs bg-slate-100 rounded p-3 overflow-x-auto">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 w-full rounded-lg bg-slate-900 text-white py-2 text-sm font-medium"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
