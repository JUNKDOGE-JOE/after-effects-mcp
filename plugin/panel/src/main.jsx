import React from 'react';
import { createRoot } from 'react-dom/client';
import 'filepond/dist/filepond.min.css';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';
import './styles/index.css';
import { App } from './app/App';

// Keep OS file drops from navigating the CEF WebView when they miss the
// attachment pond's drop zone; the pond still receives and handles its own
// drop events first (bubbling reaches this handler last).
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (event) => event.preventDefault());
}

const cs = new window.CSInterface();
createRoot(document.getElementById('root')).render(<App cs={cs} />);
