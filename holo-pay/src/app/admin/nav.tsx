export default function AdminNav({ active }: { active: "ordenes" | "revision" }) {
  return (
    <nav className="tabs">
      <a href="/admin" className={active === "ordenes" ? "on" : ""}>Órdenes</a>
      <a href="/admin/revision" className={active === "revision" ? "on" : ""}>Pagos por revisar</a>
    </nav>
  );
}
