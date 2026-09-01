#pragma once

#include <QAbstractListModel>
#include <QJsonArray>
#include <QJsonObject>

struct ToolTimelineEntry {
  QString callId;
  QString name;
  QString status = QStringLiteral("running");
  int durationMs = 0;
  QString summary;
};

class ToolTimelineModel final : public QAbstractListModel {
  Q_OBJECT

public:
  explicit ToolTimelineModel(QObject *parent = nullptr);
  int rowCount(const QModelIndex &parent = {}) const override;
  QVariant data(const QModelIndex &index, int role) const override;
  void started(const QJsonObject &params);
  void finished(const QJsonObject &params);
  void markApproval(const QString &callId, const QString &status);
  void hydrate(const QJsonArray &toolCalls);
  QString displayText(int row) const;
  void clear();

private:
  QList<ToolTimelineEntry> entries_;
};
