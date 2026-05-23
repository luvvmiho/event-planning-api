export interface AuthUser {
  id: string
  email: string | undefined
  role: "customer" | "provider" | "admin" | "authenticated"
  userType?: string
}

/** Monitoring panel JWT (`/superadmin/*`), separate from Supabase Auth. */
export interface SuperadminContext {
  username: string
  /** Set when the token was issued for a row in `monitoring_admins`. */
  monitoringAdminId?: string
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser
    superadmin: SuperadminContext
  }
}
