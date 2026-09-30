// @ts-check
import { createApi } from './api.js';
import { createController } from './controller.js';
import { createStore } from './state.js';
import { render } from './view.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
const store = createStore();
const controller = createController({ api: createApi(), store });

store.subscribe((state) => render(root, state, controller));
render(root, store.get(), controller);
void controller.start();
