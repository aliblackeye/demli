import { MaskIcon } from "../atoms/MaskIcon";

export type ReviewCardData = {
  /** Platform ikonu (mask adı): monitor (Windows) / phone (Android) */
  store: string;
  href: string;
  name: string;
  date: string;
  title: string;
  body: string;
};

/**
 * Yorum kartı — ölçülen: 406 genişlik, bg #0d0d0d, radius 24, pad 24,
 * iç kolon gap 24; header: logo 48×48 (#1a1a1a, radius 13.2) + ad/tarih;
 * içerik: başlık 18px/25.2 + gövde 18px #a3a3a3 (op .7); 5 yıldız 14px.
 */
export function ReviewCard({ data }: { data: ReviewCardData }) {
  return (
    <a
      href={data.href}
      target="_blank"
      rel="noreferrer"
      // Ölçülen: hover'da zemin #0d0d0d → rgba(23,23,23,0.72), yumuşak geçiş
      className="flex w-full flex-col rounded-[24px] bg-base p-6 backdrop-blur-[10px] transition-colors duration-[400ms] hover:bg-[rgba(23,23,23,0.72)]"
    >
      <div className="flex w-full flex-col gap-6">
        <div className="flex items-center gap-[10px]">
          <div className="flex h-12 w-12 items-center justify-center rounded-[13.2px] bg-[#1a1a1a]">
            <MaskIcon name={data.store} size={24} color="#f5f5f5" />
          </div>
          <div className="flex flex-col gap-1">
            {/* Ölçülen (390): isim lh 19.6 */}
            <strong className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-[#e5e5e5] tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">
              {data.name}
            </strong>
            <p className="text-[12px] font-medium leading-[14.4px] tracking-[-0.24px] text-text-secondary opacity-70 tb:text-[14px] tb:leading-[16.8px] tb:tracking-[-0.28px]">
              {data.date}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {/* Ölçülen (390): başlık+gövde lh 24 (150%) */}
          <strong className="text-[16px] font-medium leading-6 text-text-primary tb:text-[18px] tb:leading-[25.2px]">
            {data.title}
          </strong>
          <p className="text-[16px] leading-6 text-text-secondary opacity-70 tb:text-[18px] tb:leading-[25.2px]">{data.body}</p>
        </div>
        {/* Ölçülen (390 yerinde): kart yıldızları HER kırılımda 14px */}
        <div className="flex items-center gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <MaskIcon key={i} name="star" size={14} color="#eab30a" />
          ))}
        </div>
      </div>
    </a>
  );
}
