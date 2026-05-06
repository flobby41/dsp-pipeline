import { AppleMusicAdapter } from "./AppleMusicAdapter.js";
import { DeezerAdapter } from "./DeezerAdapter.js";
import { DSPRegistry } from "./DSPRegistry.js";
import { SpotifyAdapter } from "./SpotifyAdapter.js";

export const dspRegistry = new DSPRegistry();

dspRegistry.register(new SpotifyAdapter());
dspRegistry.register(new AppleMusicAdapter());
dspRegistry.register(new DeezerAdapter());

