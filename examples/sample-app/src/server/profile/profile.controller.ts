import { ProfileService } from "./profile.service";

const profileService = new ProfileService();

export async function profileController(userId: string): Promise<{ id: string; status: string }> {
  return profileService.loadProfile(userId);
}
