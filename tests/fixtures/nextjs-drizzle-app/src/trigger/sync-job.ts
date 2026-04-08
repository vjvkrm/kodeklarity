import { task } from "@trigger.dev/sdk";

export const syncUsersJob = task({
  id: "sync-users",
  run: async () => {
    // sync logic
  },
});

export const cleanupJob = task({
  id: "cleanup-old-posts",
  run: async () => {
    // cleanup logic
  },
});
