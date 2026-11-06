# Photo flow implementation plan

1. Add typed photo metadata and IPC; implement the bounded, cancellable cache service.
2. Connect application startup, shutdown and persisted settings to the service.
3. Add the immediate Settings toggle above Galaxy particle effect in both languages.
4. Feed cached photos into the existing animation at off-screen endpoints, with local fallback.
5. Verify scheduling/cache contracts, settings persistence, real renderer behavior,
   a live download in an isolated profile, typecheck and production build.

Existing unrelated working-tree changes must be preserved.
