export class ProfileService {
  async loadProfile(userId: string): Promise<{ id: string; status: string }> {
    return this.fetchProfile(userId);
  }

  private async fetchProfile(userId: string): Promise<{ id: string; status: string }> {
    return {
      id: userId,
      status: "active",
    };
  }
}
