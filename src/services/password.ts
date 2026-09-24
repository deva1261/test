import bcrypt from 'bcryptjs';

export class PasswordHasher {
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly rounds: number) {}

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /**
   * Burns the same bcrypt cost as a real check. Used when the email is unknown
   * so response timing does not reveal which emails are registered.
   */
  async verifyAgainstDummy(plain: string): Promise<false> {
    this.dummyHash ??= bcrypt.hash('dummy-password-for-timing', this.rounds);
    await bcrypt.compare(plain, await this.dummyHash);
    return false;
  }
}
