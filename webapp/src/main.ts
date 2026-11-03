import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { ws } from './lib/ws';

const app = mount(App, { target: document.getElementById('app')! });
ws.connect();

export default app;
