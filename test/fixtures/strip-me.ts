export default {
  name: "strip-me",
  run(): Promise<{ status: "refused"; reason: string }> {
    return Promise.resolve({ status: "refused", reason: "strip me" });
  },
};
