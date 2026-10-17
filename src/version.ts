/**
 * orc's version: package.json `version`, imported statically so `bun build --compile`
 * embeds it in the binary. (Reading ../../package.json at runtime does not work there:
 * the path resolves inside the binary's virtual /$bunfs filesystem.)
 */
import pkg from '../package.json';

export const VERSION: string = pkg.version;
