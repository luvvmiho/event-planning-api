import { Hono } from "hono"
import { supabase } from "../lib/supabase.js"

export const categoriesRouter = new Hono()

categoriesRouter.get("/", async (c) => {
  const { data, error } = await supabase
    .from("categories")
    .select("id, slug, name, sort_order")
    .order("sort_order", { ascending: true })

  if (error) return c.json({ error: error.message }, 500)

  return c.json({ data })
})

categoriesRouter.get("/:slug", async (c) => {
  const slug = c.req.param("slug")

  const { data, error } = await supabase
    .from("categories")
    .select("id, slug, name, sort_order")
    .eq("slug", slug)
    .maybeSingle()

  if (error) return c.json({ error: error.message }, 500)
  if (!data) return c.json({ error: "Category not found" }, 404)

  return c.json({ data })
})
