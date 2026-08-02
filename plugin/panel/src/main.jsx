import React from 'react';
import { createRoot } from 'react-dom/client';
import 'filepond/dist/filepond.min.css';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';
import './styles/index.css';
import { App } from './app/App';

const cs = new window.CSInterface();
createRoot(document.getElementById('root')).render(<App cs={cs} />);
