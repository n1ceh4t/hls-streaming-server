/**
 * Admin User Domain Model
 */
export interface AdminUserData {
  id: string;
  username: string;
  passwordHash: string;
  email?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

export class AdminUser {
  constructor(private data: AdminUserData) {}

  get id(): string {
    return this.data.id;
  }

  get username(): string {
    return this.data.username;
  }

  get email(): string | undefined {
    return this.data.email;
  }

  get isActive(): boolean {
    return this.data.isActive;
  }

  get createdAt(): Date {
    return this.data.createdAt;
  }

  get updatedAt(): Date {
    return this.data.updatedAt;
  }

  get lastLoginAt(): Date | undefined {
    return this.data.lastLoginAt;
  }

  updateLastLogin(): void {
    this.data.lastLoginAt = new Date();
  }

  toJSON(): Omit<AdminUserData, 'passwordHash'> {
    return {
      id: this.data.id,
      username: this.data.username,
      email: this.data.email,
      isActive: this.data.isActive,
      createdAt: this.data.createdAt,
      updatedAt: this.data.updatedAt,
      lastLoginAt: this.data.lastLoginAt,
    };
  }
}

