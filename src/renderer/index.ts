import { NanoApp } from './app';
import './stylesheets';

document.body.appendChild(new NanoApp());

export const instance = NanoApp.instance;
