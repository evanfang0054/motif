/**
 * 管理后台首页。地基阶段为占位页，Plan 2 将替换为概览看板。
 * 存在意义：让「守卫 → 路由 → 渲染」这条链路可被端到端验证。
 */
export default function AdminHomePage() {
  return (
    <section className="admin-panel">
      <h1 className="admin-title">管理后台已就绪</h1>
      <p className="admin-muted">
        三级角色与管理员引导已生效。CDK、订单、用户、反馈、日志与系统设置页面将在后续迭代中接入。
      </p>
    </section>
  )
}
