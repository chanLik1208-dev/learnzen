import { createApp } from 'vue';
import { MotionPlugin } from 'motion-v';
import App from './App.vue';
import { router } from './router.js';
import './styles.css';

createApp(App).use(router).use(MotionPlugin).mount('#app');
