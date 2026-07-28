import { LifeBuoy } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { SupportReportCard } from "@/components/dashboard/SupportReportCard";
import { useT } from "@/lib/i18n";

export function SupportPage() {
  const t = useT();
  return (
    <div className="mx-auto max-w-4xl px-5 py-8 sm:px-8">
      <PageHeader
        eyebrow={t("Помощь")}
        title={t("Поддержка")}
        subtitle={t("Что-то работает не так? Отправьте нам отчёт в один клик — приложение само соберёт нужные данные, а мы поможем разобраться.")}
        icon={LifeBuoy}
      />
      <SupportReportCard />
    </div>
  );
}
