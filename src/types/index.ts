export interface AuthUser {
  id: string
  email: string | undefined
  role: "customer" | "provider" | "admin" | "authenticated"
  userType?: string
}

export interface SuperadminContext {
  username: string
  monitoringAdminId?: string
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser
    superadmin: SuperadminContext
  }
}
