import { registerRoot } from "remotion";
import { Root } from "./Root";

/** An entry point that throws before it registers anything, as a missing environment variable check would. */
if (Date.now() > 0) throw new Error("module scope boom");
registerRoot(Root);
