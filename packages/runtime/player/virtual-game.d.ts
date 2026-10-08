/** The game embedded by `vibe export` (see packages/runtime/export). */
declare module 'virtual:vibe-game' {
  const game: {
    /** Project folder name (also the save key). */
    name: string;
    /** Window / app title. */
    title: string;
    /** Raw project data (project.json + scenes + scripts + items...), validated again on load. */
    project: unknown;
  };
  export default game;
}
