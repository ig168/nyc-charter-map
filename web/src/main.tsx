import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// The root uses `display: contents`, so the page layout (body.app flex column) is unchanged.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
