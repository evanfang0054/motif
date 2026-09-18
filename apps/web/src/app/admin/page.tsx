/**
 * 管理后台首页。当前为占位页，Plan 3 将替换为概览看板。
 * 存在意义：让「守卫 → 路由 → 渲染」这条链路可被端到端验证。
 */
export default function AdminHomePage() {
  return (
    <section className="admin-panel">
      <h1 className="admin-title">管理后台已就绪</h1>
      <p className="admin-muted">
        左侧菜单中的 CDK 与订单已可用；概览、用户、反馈、生成日志、审计与系统设置将在后续迭代中接入。
      </p>
    </section>
  )
}
