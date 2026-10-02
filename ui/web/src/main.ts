import '@fontsource-variable/newsreader';
import '@fontsource-variable/schibsted-grotesk';
import { createApp } from 'vue';
import App from './App.vue';
import { initToken, watchTokenHash } from './api';
import './styles/tokens.css';
import './styles/base.css';
import { useTheme } from './theme';

useTheme(); // applies the saved theme before the first paint
const connected = initToken();
watchTokenHash();
createApp(App, { connected }).mount('#app');
