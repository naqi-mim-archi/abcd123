import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installApiAuthInterceptor } from './services/firebase/apiAuthInterceptor';

// Installed before React mounts so the very first /api/* request already carries the
// caller's Firebase ID token — every one of those routes now answers 401 without it.
installApiAuthInterceptor();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);