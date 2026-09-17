function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span className="lp-brand-mark" style={{ width: size, height: size, fontSize: size * 0.46 }} aria-hidden>
      P
    </span>
  )
}

export { BrandMark }
