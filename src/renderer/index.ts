import { NanoApp } from "./app";
import "./style.css";

document.body.appendChild(new NanoApp());

export const instance = NanoApp.instance;
