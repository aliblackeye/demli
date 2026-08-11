import { MaskIcon } from "../atoms/MaskIcon";

export type ReviewCardData = {
  store: "apple" | "google-play";
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
      className="flex w-full flex-col rounded-[24px] bg-base p-6 tb:w-[406px]"
    >
      <div className="flex w-full flex-col gap-6">
        <div className="flex items-center gap-[10px]">
          <div className="flex h-12 w-12 items-center justify-center rounded-[13.2px] bg-[#1a1a1a]">
            <MaskIcon name={data.store} size={24} color="#f5f5f5" />
          </div>
          <div className="flex flex-col gap-1">
            <strong className="text-[16px] font-medium leading-[19.2px] tracking-[-0.32px] text-[#e5e5e5]">
              {data.name}
            </strong>
            <p className="text-[14px] font-medium leading-[16.8px] tracking-[-0.28px] text-text-secondary opacity-70">
              {data.date}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <strong className="text-[18px] font-medium leading-[25.2px] text-text-primary">
            {data.title}
          </strong>
          <p className="text-[18px] leading-[25.2px] text-text-secondary opacity-70">{data.body}</p>
        </div>
        <div className="flex items-center gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <MaskIcon key={i} name="star" size={14} color="#eab30a" />
          ))}
        </div>
      </div>
    </a>
  );
}
